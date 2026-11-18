-- C11 公海与转换（R-CRM-02）。
--
-- 并发安全：认领与回收都用 `WHERE version = 期望值` 的条件更新（乐观锁），
-- 两个人对同一条线索同时点认领，只有一个能成功——不是靠事务隔离碰运气。
-- 幂等转换：converted_customer_id 一旦写入就不再变，重复调用返回同一个客户 id，
-- 绝不产生第二个客户或第二张订单。
CREATE OR REPLACE FUNCTION public.claim_lead (requested_lead_id uuid, requested_version integer) RETURNS TABLE (error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  updated integer;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.leads AS lead
  SET
    owner_id = (SELECT auth.uid ()),
    version = lead.version + 1,
    updated_at = pg_catalog.now ()
  WHERE lead.id = requested_lead_id
    AND lead.organization_id = current_org_id
    AND lead.owner_id IS NULL
    AND lead.version = requested_version
    AND lead.converted_customer_id IS NULL;

  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated = 0 THEN
    RETURN QUERY SELECT 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  INSERT INTO public.lead_events (organization_id, lead_id, event_type, detail, actor_id)
  VALUES (current_org_id, requested_lead_id, 'claimed', '从公海认领', (SELECT auth.uid ()));

  RETURN QUERY SELECT NULL::text;
END;
$$;


CREATE OR REPLACE FUNCTION public.assign_lead (
  requested_lead_id uuid,
  requested_owner_id uuid,
  requested_version integer
) RETURNS TABLE (error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  updated integer;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.has_permission ('member.manage')) THEN
    RAISE EXCEPTION 'member.manage is required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_members AS member
    WHERE member.organization_id = current_org_id
      AND member.user_id = requested_owner_id
  ) THEN
    RETURN QUERY SELECT 'OWNER_NOT_MEMBER'::text;
    RETURN;
  END IF;

  UPDATE public.leads AS lead
  SET
    owner_id = requested_owner_id,
    version = lead.version + 1,
    updated_at = pg_catalog.now ()
  WHERE lead.id = requested_lead_id
    AND lead.organization_id = current_org_id
    AND lead.version = requested_version
    AND lead.converted_customer_id IS NULL;

  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated = 0 THEN
    RETURN QUERY SELECT 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  INSERT INTO public.lead_events (organization_id, lead_id, event_type, detail, actor_id)
  VALUES (current_org_id, requested_lead_id, 'assigned', '分配负责人', (SELECT auth.uid ()));

  RETURN QUERY SELECT NULL::text;
END;
$$;


-- 超时回收：7 个自然日没有任何跟进（last_follow_up_at 为空则按创建时间）即回公海。
-- 由调度器按租户调用；返回回收条数，便于监控。
CREATE OR REPLACE FUNCTION public.recycle_stale_leads (
  requested_now timestamptz DEFAULT pg_catalog.now ()
) RETURNS TABLE (recycled_count integer) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  recycled integer;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.leads AS lead
  SET
    owner_id = NULL,
    version = lead.version + 1,
    updated_at = requested_now
  WHERE lead.organization_id = current_org_id
    AND lead.owner_id IS NOT NULL
    AND lead.converted_customer_id IS NULL
    AND requested_now > coalesce(lead.last_follow_up_at, lead.created_at) + interval '7 days';

  GET DIAGNOSTICS recycled = ROW_COUNT;

  INSERT INTO public.lead_events (organization_id, lead_id, event_type, detail, actor_id)
  SELECT current_org_id, lead.id, 'recycled', '超过 7 天未跟进，回到公海', NULL
  FROM public.leads AS lead
  WHERE lead.organization_id = current_org_id
    AND lead.owner_id IS NULL
    AND lead.version > 1
    AND lead.id IN (
      SELECT lead2.id
      FROM public.leads AS lead2
      WHERE lead2.organization_id = current_org_id
        AND requested_now > coalesce(lead2.last_follow_up_at, lead2.created_at) + interval '7 days'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.lead_events AS event
      WHERE event.organization_id = current_org_id
        AND event.lead_id = lead.id
        AND event.event_type = 'recycled'
        AND event.created_at > requested_now - interval '1 minute'
    );

  RETURN QUERY SELECT recycled;
END;
$$;


-- 幂等转客户：已转换则直接返回原客户 id；重复客户按 phone_normalized 关联既有客户。
CREATE OR REPLACE FUNCTION public.convert_lead_to_customer (requested_lead_id uuid) RETURNS TABLE (result_customer_id uuid, error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  target public.leads%ROWTYPE;
  existing_customer_id uuid;
  new_customer_id uuid;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target FROM public.leads AS lead
  WHERE lead.id = requested_lead_id
    AND lead.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  -- 幂等：第二次调用直接返回第一次的结果，不建第二个客户。
  IF target.converted_customer_id IS NOT NULL THEN
    RETURN QUERY SELECT target.converted_customer_id, NULL::text;
    RETURN;
  END IF;

  IF target.stage <> 'won' THEN
    RETURN QUERY SELECT NULL::uuid, 'STAGE_NOT_WON'::text;
    RETURN;
  END IF;

  IF target.phone IS NOT NULL THEN
    SELECT customer.id INTO existing_customer_id
    FROM public.customers AS customer
    WHERE customer.organization_id = current_org_id
      AND customer.phone_normalized = regexp_replace(target.phone, '[^0-9]', '', 'g')
    LIMIT 1;
  END IF;

  IF existing_customer_id IS NULL THEN
    INSERT INTO public.customers (organization_id, name, phone, email, created_by)
    VALUES (
      current_org_id, target.name, target.phone, target.email, (SELECT auth.uid ())
    ) RETURNING id INTO new_customer_id;
  ELSE
    new_customer_id := existing_customer_id;
  END IF;

  UPDATE public.leads AS lead
  SET converted_customer_id = new_customer_id, updated_at = pg_catalog.now ()
  WHERE lead.id = target.id;

  INSERT INTO public.lead_events (organization_id, lead_id, event_type, detail, actor_id)
  VALUES (
    current_org_id, target.id, 'converted',
    CASE WHEN existing_customer_id IS NULL THEN '转换为新客户' ELSE '关联既有客户' END,
    (SELECT auth.uid ())
  );

  RETURN QUERY SELECT new_customer_id, NULL::text;
END;
$$;


REVOKE ALL ON FUNCTION public.claim_lead (uuid, integer)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.assign_lead (uuid, uuid, integer)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.recycle_stale_leads (timestamptz)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.convert_lead_to_customer (uuid)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.claim_lead (uuid, integer) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.assign_lead (uuid, uuid, integer) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.recycle_stale_leads (timestamptz) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.convert_lead_to_customer (uuid) TO authenticated;