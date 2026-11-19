-- CRM 线索转订单 + 阶段统计（R-CRM-01 的收尾两件）
--
-- 口径（写死在这里，避免以后各处自己算一套）：
-- 1. **只有 won 才能转订单**：与 `convert_lead_to_customer` 保持一致，
--    线索未成单就开单，等于绕过销售漏斗直接造单。
-- 2. **订单是预订单（booking）且金额留空**：线索里只有预算区间，那是意向不是报价。
--    把预算写成应收会污染报表与余额口径；金额由销售在订单页自己填。
-- 3. **幂等**：`converted_order_id` 记下第一次建的订单，重复调用返回同一张。
-- 4. 转换成功后线索阶段视为终态，不再接受跟进改写（won 已由转换前置校验保证）。

-- 复合外键的被引用侧 `orders (id, organization_id)` 上已有
-- `orders_id_organization_key`（20261029000002），这里不再重复建。


ALTER TABLE public.leads
ADD COLUMN converted_order_id uuid;


ALTER TABLE public.leads
ADD CONSTRAINT leads_converted_order_tenant_fk FOREIGN KEY (
  converted_order_id, organization_id
) REFERENCES public.orders (id, organization_id) ON DELETE SET NULL;


-- 事件类型放宽一格：转订单是一条独立事件，混进 'converted' 会让时间线分不清
-- 「转成了客户」还是「开了单」。
ALTER TABLE public.lead_events DROP CONSTRAINT lead_events_event_type_check;


ALTER TABLE public.lead_events
ADD CONSTRAINT lead_events_event_type_check CHECK (
  event_type IN (
    'created',
    'stage_changed',
    'follow_up',
    'claimed',
    'assigned',
    'recycled',
    'converted',
    'order_created'
  )
);


CREATE OR REPLACE FUNCTION public.convert_lead_to_order (
  requested_lead_id uuid,
  requested_version integer,
  requested_remark text DEFAULT NULL
) RETURNS TABLE (result_order_id uuid, error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  target public.leads%ROWTYPE;
  conversion record;
  new_order_id uuid;
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

  -- 幂等：先看有没有开过单，再看版本。否则「重复点击」会被误报成版本冲突。
  IF target.converted_order_id IS NOT NULL THEN
    RETURN QUERY SELECT target.converted_order_id, NULL::text;
    RETURN;
  END IF;

  IF target.version <> requested_version THEN
    RETURN QUERY SELECT NULL::uuid, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  IF target.stage <> 'won' THEN
    RETURN QUERY SELECT NULL::uuid, 'STAGE_NOT_WON'::text;
    RETURN;
  END IF;

  -- 复用既有转换：它自己会做手机号去重与幂等，这里不再写第二份。
  SELECT * INTO conversion FROM public.convert_lead_to_customer (target.id);
  IF conversion.error_code IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, conversion.error_code;
    RETURN;
  END IF;

  new_order_id := public.create_order_with_items (
    conversion.result_customer_id,
    'booking',
    '[]'::jsonb,
    '[]'::jsonb,
    target.destination,
    target.expected_date,
    NULL,
    target.adult_count,
    target.child_count,
    COALESCE(NULLIF(btrim(requested_remark), ''), '由 CRM 线索转入，金额待补')
  );

  UPDATE public.leads AS lead
  SET
    converted_order_id = new_order_id,
    updated_at = pg_catalog.now ()
  WHERE lead.id = target.id;

  INSERT INTO public.lead_events (organization_id, lead_id, event_type, detail, actor_id)
  VALUES (
    current_org_id, target.id, 'order_created',
    '已转预订单（金额待补）', (SELECT auth.uid ())
  );

  RETURN QUERY SELECT new_order_id, NULL::text;
END;
$$;


REVOKE ALL ON FUNCTION public.convert_lead_to_order (uuid, integer, text)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.convert_lead_to_order (uuid, integer, text) TO authenticated;


-- 阶段统计：只统计区间内**新建**的线索，按当前所处阶段分组。
-- 不按历史到达复算——`lead_events` 存的是跟进正文，没有结构化的「从 X 到 Y」，
-- 硬解析文本会把统计做成猜测。
CREATE OR REPLACE FUNCTION public.lead_funnel (requested_from date, requested_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  summary jsonb;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'from', requested_from,
    'to', requested_to,
    'total', (
      SELECT count(*) FROM public.leads AS lead
      WHERE lead.organization_id = current_org_id
        AND lead.created_at >= requested_from
        AND lead.created_at < requested_to + 1
    ),
    'stages', COALESCE(
      (
        SELECT pg_catalog.jsonb_object_agg(stage_counts.stage, stage_counts.total)
        FROM (
          SELECT lead.stage::text AS stage, count(*) AS total
          FROM public.leads AS lead
          WHERE lead.organization_id = current_org_id
            AND lead.created_at >= requested_from
            AND lead.created_at < requested_to + 1
          GROUP BY lead.stage
        ) AS stage_counts
      ),
      '{}'::jsonb
    ),
    'convertedCustomers', (
      SELECT count(*) FROM public.leads AS lead
      WHERE lead.organization_id = current_org_id
        AND lead.created_at >= requested_from
        AND lead.created_at < requested_to + 1
        AND lead.converted_customer_id IS NOT NULL
    ),
    'convertedOrders', (
      SELECT count(*) FROM public.leads AS lead
      WHERE lead.organization_id = current_org_id
        AND lead.created_at >= requested_from
        AND lead.created_at < requested_to + 1
        AND lead.converted_order_id IS NOT NULL
    )
  ) INTO summary;

  RETURN summary;
END;
$$;


REVOKE ALL ON FUNCTION public.lead_funnel (date, date)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.lead_funnel (date, date) TO authenticated;
