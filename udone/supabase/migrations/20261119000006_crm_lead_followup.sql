-- C11 CRM 线索 RPC（R-CRM-01）：建线索、跟进、阶段变更。
--
-- 所有写都走 SECURITY DEFINER 函数，应用不能直接 INSERT/UPDATE 线索表，
-- 这样「每次变更都追加事件」不是靠调用方自觉，而是结构上无法绕过。
CREATE OR REPLACE FUNCTION public.create_lead (
  requested_name text,
  requested_phone text DEFAULT NULL,
  requested_wechat text DEFAULT NULL,
  requested_email text DEFAULT NULL,
  requested_source text DEFAULT NULL,
  requested_destination text DEFAULT NULL,
  requested_departure_city text DEFAULT NULL,
  requested_trip_type text DEFAULT NULL,
  requested_intent_level text DEFAULT NULL,
  requested_expected_date date DEFAULT NULL,
  requested_budget_min numeric DEFAULT NULL,
  requested_budget_max numeric DEFAULT NULL,
  requested_adult_count integer DEFAULT 0,
  requested_child_count integer DEFAULT 0,
  requested_remark text DEFAULT NULL
) RETURNS TABLE (result_lead_id uuid, error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  new_lead_id uuid;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.has_permission ('order.write')) THEN
    RAISE EXCEPTION 'order.write is required' USING ERRCODE = '42501';
  END IF;
  IF requested_name IS NULL
    OR length(btrim(requested_name)) = 0
    OR requested_phone IS NULL
    OR length(btrim(requested_phone)) = 0
    OR requested_source IS NULL
    OR length(btrim(requested_source)) = 0
    OR requested_destination IS NULL
    OR length(btrim(requested_destination)) = 0
    OR requested_departure_city IS NULL
    OR length(btrim(requested_departure_city)) = 0
    OR requested_trip_type IS NULL
    OR length(btrim(requested_trip_type)) = 0
    OR requested_intent_level IS NULL
    OR length(btrim(requested_intent_level)) = 0
    OR requested_expected_date IS NULL
    OR requested_budget_min IS NULL
    OR requested_budget_max IS NULL
    OR requested_budget_min < 0
    OR requested_budget_max < requested_budget_min THEN
    RETURN QUERY SELECT NULL::uuid, 'VALIDATION_ERROR'::text;
    RETURN;
  END IF;

  INSERT INTO public.leads (
    organization_id, name, phone, wechat, email, source, destination, departure_city,
    trip_type, intent_level, expected_date, budget_min, budget_max,
    adult_count, child_count, remark, owner_id, created_by
  ) VALUES (
    current_org_id, btrim(requested_name), btrim(requested_phone),
    nullif(btrim(requested_wechat), ''), nullif(btrim(requested_email), ''),
    btrim(requested_source), btrim(requested_destination), btrim(requested_departure_city),
    btrim(requested_trip_type), btrim(requested_intent_level),
    requested_expected_date, requested_budget_min, requested_budget_max,
    requested_adult_count, requested_child_count, requested_remark,
    (SELECT auth.uid ()), (SELECT auth.uid ())
  ) RETURNING id INTO new_lead_id;

  INSERT INTO public.lead_events (organization_id, lead_id, event_type, detail, actor_id)
  VALUES (current_org_id, new_lead_id, 'created', '线索创建', (SELECT auth.uid ()));

  RETURN QUERY SELECT new_lead_id, NULL::text;
END;
$$;


-- 跟进 + 阶段变更共用一个函数：每次变更都追加事件，并推进版本号。
CREATE OR REPLACE FUNCTION public.record_lead_follow_up (
  requested_lead_id uuid,
  requested_stage public.lead_stage,
  requested_detail text,
  requested_next_follow_up_at timestamptz DEFAULT NULL
) RETURNS TABLE (error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  target public.leads%ROWTYPE;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target FROM public.leads AS lead
  WHERE lead.id = requested_lead_id
    AND lead.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text;
    RETURN;
  END IF;
  IF target.owner_id IS DISTINCT FROM (SELECT auth.uid ()) THEN
    RETURN QUERY SELECT 'NOT_OWNER'::text;
    RETURN;
  END IF;
  IF requested_detail IS NULL OR length(btrim(requested_detail)) = 0 THEN
    RETURN QUERY SELECT 'DETAIL_REQUIRED'::text;
    RETURN;
  END IF;

  UPDATE public.leads AS lead
  SET
    stage = requested_stage,
    last_follow_up_at = pg_catalog.now (),
    next_follow_up_at = requested_next_follow_up_at,
    version = lead.version + 1,
    updated_at = pg_catalog.now ()
  WHERE lead.id = target.id;

  INSERT INTO public.lead_events (organization_id, lead_id, event_type, detail, actor_id)
  VALUES (
    current_org_id, target.id,
    CASE WHEN requested_stage IS DISTINCT FROM target.stage THEN 'stage_changed' ELSE 'follow_up' END,
    btrim(requested_detail), (SELECT auth.uid ())
  );

  RETURN QUERY SELECT NULL::text;
END;
$$;


REVOKE ALL ON FUNCTION public.create_lead (
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  date,
  numeric,
  numeric,
  integer,
  integer,
  text
)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.record_lead_follow_up (uuid, public.lead_stage, text, timestamptz)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.create_lead (
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  date,
  numeric,
  numeric,
  integer,
  integer,
  text
) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.record_lead_follow_up (uuid, public.lead_stage, text, timestamptz) TO authenticated;