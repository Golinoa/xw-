-- 订单编辑不再「把金额行整体删掉再插入」。
--
-- 旧实现每次保存都 DELETE 全部明细再 INSERT，而插入只带 name/amount，
-- confirmed_amount / pending_amount 因此回落成 0。后果不是「显示不对」：
-- 客户已确认的 3000 元收款被静默抹掉，利润跟着变，而且没有任何报错。
--
-- 新实现按 id 增量合并：带 id 的原地更新、不带 id 的新增、请求里缺席的才删除。
-- 删除和改额都先做冲突判定——有收付款的行不能被一次表单提交悄悄清掉。
--
-- 签名与旧版完全一致，所以 CREATE OR REPLACE 保留原有 ACL，
-- 不需要重新 GRANT EXECUTE。
--
-- 但 UPDATE 权限确实要补：`order_receivables_update_writer` 策略在
-- 20261029000003 里就写好了，列级 UPDATE 授权却一直缺席，于是明细行此前只能
-- 插入和删除——策略写了却从未被用到。不开这个授权，下面的原地更新会直接
-- permission denied。
--
-- 只开 name / amount / updated_at（应付再加 supplier_id）。
-- confirmed_amount / pending_amount 仍然不开放：它们只能由收付款流程写，
-- 否则「已确认金额不可随手改」这条不变式当场失效，本轮修的东西也就白修了。
GRANT
UPDATE (name, amount, updated_at) ON public.order_receivables TO authenticated;


GRANT
UPDATE (supplier_id, name, amount, updated_at) ON public.order_payables TO authenticated;


CREATE OR REPLACE FUNCTION public.update_order_with_items (
  requested_order_id uuid,
  requested_version integer,
  requested_customer_id uuid,
  requested_order_type text,
  requested_receivables jsonb,
  requested_payables jsonb,
  requested_route_name text DEFAULT NULL,
  requested_departure_date date DEFAULT NULL,
  requested_return_date date DEFAULT NULL,
  requested_adult_count integer DEFAULT 0,
  requested_child_count integer DEFAULT 0,
  requested_remark text DEFAULT NULL
) RETURNS TABLE (result_order_id uuid, error_code text) LANGUAGE plpgsql
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_order public.orders%ROWTYPE;
  kept_receivable_ids text[];
  kept_payable_ids text[];
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_order FROM public.orders AS orders
  WHERE orders.id = requested_order_id
    AND orders.organization_id = current_org_id
    AND orders.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF current_order.version <> requested_version THEN
    RETURN QUERY SELECT NULL::uuid, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(requested_payables, '[]'::jsonb)) AS item
    WHERE NOT EXISTS (
      SELECT 1 FROM public.suppliers AS supplier
      WHERE supplier.id = (item ->> 'supplierId')::uuid
        AND supplier.organization_id = current_org_id
        AND supplier.is_active
    )
  ) THEN
    RAISE EXCEPTION 'supplier_not_available' USING ERRCODE = '23503';
  END IF;

  -- 锁团后编辑受限：必须先解锁再改（R-ORDER-02）。
  IF current_order.status = 'completed' THEN
    RETURN QUERY SELECT NULL::uuid, 'ORDER_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  IF current_order.status = 'cancelled' THEN
    RETURN QUERY SELECT NULL::uuid, 'ORDER_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  -- 请求里带 id 的行即「要保留的行」。用 text 比较而不是转 uuid：
  -- id 不合法时只会被判成「不属于本订单」，不会抛 22P02 变成 500。
  --
  -- DISTINCT 不是为了去重好看：下面用 cardinality 与「带 id 的行数」比对来发现
  -- 重复 id。若这里保留重复，两边永远相等，检查就形同虚设。
  SELECT
    coalesce(array_agg(DISTINCT item ->> 'id'), '{}')
  INTO kept_receivable_ids
  FROM jsonb_array_elements(coalesce(requested_receivables, '[]'::jsonb)) AS item
  WHERE item ->> 'id' IS NOT NULL;

  SELECT
    coalesce(array_agg(DISTINCT item ->> 'id'), '{}')
  INTO kept_payable_ids
  FROM jsonb_array_elements(coalesce(requested_payables, '[]'::jsonb)) AS item
  WHERE item ->> 'id' IS NOT NULL;

  -- 同一个 id 出现两次会让 UPDATE 写两次，最终值取决于执行顺序。
  IF (
    SELECT count(*)
    FROM jsonb_array_elements(coalesce(requested_receivables, '[]'::jsonb)) AS item
    WHERE item ->> 'id' IS NOT NULL
  ) <> cardinality(kept_receivable_ids) THEN
    RETURN QUERY SELECT NULL::uuid, 'LINE_DUPLICATE'::text;
    RETURN;
  END IF;

  IF (
    SELECT count(*)
    FROM jsonb_array_elements(coalesce(requested_payables, '[]'::jsonb)) AS item
    WHERE item ->> 'id' IS NOT NULL
  ) <> cardinality(kept_payable_ids) THEN
    RETURN QUERY SELECT NULL::uuid, 'LINE_DUPLICATE'::text;
    RETURN;
  END IF;

  -- 引用的行必须属于这张订单：否则带上别的订单的行 id 就能越权改金额。
  IF EXISTS (
    SELECT 1
    FROM unnest(kept_receivable_ids) AS kept (id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.order_receivables AS line
      WHERE line.id::text = kept.id
        AND line.order_id = requested_order_id
    )
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'LINE_NOT_FOUND'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(kept_payable_ids) AS kept (id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.order_payables AS line
      WHERE line.id::text = kept.id
        AND line.order_id = requested_order_id
    )
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'LINE_NOT_FOUND'::text;
    RETURN;
  END IF;

  -- 改额不能低于已经发生的收付款，否则 available_amount 变负数，
  -- 数据库的 capacity 约束会抛 23514，在 API 上表现为 500。
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(requested_receivables, '[]'::jsonb)) AS item
    JOIN public.order_receivables AS line
      ON line.id::text = item ->> 'id'
      AND line.order_id = requested_order_id
    WHERE (item ->> 'amount')::numeric(14, 2) < line.confirmed_amount + line.pending_amount
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'LINE_AMOUNT_CONFLICT'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(requested_payables, '[]'::jsonb)) AS item
    JOIN public.order_payables AS line
      ON line.id::text = item ->> 'id'
      AND line.order_id = requested_order_id
    WHERE (item ->> 'amount')::numeric(14, 2) < line.confirmed_amount + line.pending_amount
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'LINE_AMOUNT_CONFLICT'::text;
    RETURN;
  END IF;

  -- 有收付款的行不允许删除。整表替换时代的清零是静默的，
  -- 这里宁可挡住并要求先处理款项，也不能让资金记录凭空消失。
  IF EXISTS (
    SELECT 1 FROM public.order_receivables AS line
    WHERE line.order_id = requested_order_id
      AND NOT (line.id::text = ANY (kept_receivable_ids))
      AND (line.confirmed_amount > 0 OR line.pending_amount > 0)
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'LINE_HAS_PAYMENTS'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_payables AS line
    WHERE line.order_id = requested_order_id
      AND NOT (line.id::text = ANY (kept_payable_ids))
      AND (line.confirmed_amount > 0 OR line.pending_amount > 0)
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'LINE_HAS_PAYMENTS'::text;
    RETURN;
  END IF;

  UPDATE public.orders AS orders
  SET
    customer_id = requested_customer_id,
    order_type = requested_order_type,
    route_name = requested_route_name,
    departure_date = requested_departure_date,
    return_date = requested_return_date,
    adult_count = coalesce(requested_adult_count, 0),
    child_count = coalesce(requested_child_count, 0),
    remark = requested_remark,
    version = current_order.version + 1,
    updated_by = (SELECT auth.uid ()),
    updated_at = now()
  WHERE orders.id = requested_order_id;

  UPDATE public.order_receivables AS line
  SET
    name = item ->> 'name',
    amount = (item ->> 'amount')::numeric(14, 2),
    updated_at = now()
  FROM jsonb_array_elements(coalesce(requested_receivables, '[]'::jsonb)) AS item
  WHERE line.order_id = requested_order_id
    AND item ->> 'id' IS NOT NULL
    AND line.id::text = item ->> 'id';

  DELETE FROM public.order_receivables AS line
  WHERE line.order_id = requested_order_id
    AND NOT (line.id::text = ANY (kept_receivable_ids));

  INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
  SELECT
    current_org_id,
    requested_order_id,
    item ->> 'name',
    (item ->> 'amount')::numeric(14, 2)
  FROM jsonb_array_elements(coalesce(requested_receivables, '[]'::jsonb)) AS item
  WHERE item ->> 'id' IS NULL;

  UPDATE public.order_payables AS line
  SET
    supplier_id = (item ->> 'supplierId')::uuid,
    name = item ->> 'name',
    amount = (item ->> 'amount')::numeric(14, 2),
    updated_at = now()
  FROM jsonb_array_elements(coalesce(requested_payables, '[]'::jsonb)) AS item
  WHERE line.order_id = requested_order_id
    AND item ->> 'id' IS NOT NULL
    AND line.id::text = item ->> 'id';

  DELETE FROM public.order_payables AS line
  WHERE line.order_id = requested_order_id
    AND NOT (line.id::text = ANY (kept_payable_ids));

  INSERT INTO public.order_payables (organization_id, order_id, supplier_id, name, amount)
  SELECT
    current_org_id,
    requested_order_id,
    (item ->> 'supplierId')::uuid,
    item ->> 'name',
    (item ->> 'amount')::numeric(14, 2)
  FROM jsonb_array_elements(coalesce(requested_payables, '[]'::jsonb)) AS item
  WHERE item ->> 'id' IS NULL;

  PERFORM public.recalculate_order_totals (requested_order_id);

  RETURN QUERY SELECT requested_order_id, NULL::text;
END;
$$;