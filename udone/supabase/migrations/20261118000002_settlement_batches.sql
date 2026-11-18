-- 批量结算（R-SETTLE-01）。
--
-- 结算批次是「这个月这家供应商该结多少」的对账凭证，不是付款流水：
-- 它只锁定「这条应付明细已经安排进某个月的结算」，真正出钱仍然走
-- finance_applications 的付款申请与审批。需求写明「不重复生成付款流水」，
-- 所以这里一分钱都不写进 pending_amount / confirmed_amount。
--
-- 为什么不把占用量加到 order_payables：
--   pending_amount 已经是「付款申请在途」的口径。结算再叠一笔，同一块钱会被
--   算两次在途，可申请余额和报表同时偏小。结算的占用量单独记在 settlement_items，
--   用「累计已确认结算金额 ≤ 应付金额」封顶，两条口径互不干扰。
--
-- 为什么不对 order_payables 加外键：
--   加 CASCADE 会让已确认批次的金额随订单行删除被悄悄改小；加 RESTRICT 又会让
--   「结算过的一行」把正常订单编辑卡成 409，而报出来的文案（客户/供应商不属于
--   本组织）与真实原因无关。结算单本来就是快照型凭证（同 C4 线路存名称快照），
--   这里保存 order_number / payable_name / amount 快照，确认时再回查校验。
--
-- 「每条应付明细只能进入一个已确认结算批次」按**累计金额封顶**实现，而不是
-- 「一条明细一辈子只能进一个批次」：后者会让部分结算（先结 400，尾款 600 下月结）
-- 永远结不掉尾款，与需求里「余额不足的项目不得重复结算」自相矛盾。
-- 现在的口径是：累计已确认结算金额 + 本次金额 ≤ 应付金额，超了就报
-- AMOUNT_EXCEEDS_AVAILABLE，这才是「不得重复结算」真正要挡的事。
CREATE TABLE public.settlement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL,
  -- 自然月：只存当月 1 号，避免「2026-11-03」和「2026-11-28」被当成两个周期。
  period_start date NOT NULL CHECK (
    period_start = date_trunc('month', period_start)::date
  ),
  method text NOT NULL CHECK (
    method IN ('cash', 'bank', 'alipay', 'wechat', 'other')
  ),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  total_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  note text CHECK (
    note IS NULL
    OR length(note) <= 500
  ),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancel_reason text CHECK (
    cancel_reason IS NULL
    OR length(cancel_reason) <= 500
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_batches_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT settlement_batches_supplier_tenant_fk FOREIGN KEY (supplier_id, organization_id) REFERENCES public.suppliers (id, organization_id) ON DELETE RESTRICT,
  -- 已确认必须有确认时刻；作废保留原确认时刻（审计要能回答「它曾经确认过」）。
  CONSTRAINT settlement_batches_confirmed_shape CHECK (
    status <> 'confirmed'
    OR confirmed_at IS NOT NULL
  )
);


-- 一个供应商每个月只能有一个未作废批次：同月重开会让「这个月结了多少」出现两个答案。
-- 草稿也计入，因为草稿就是「已选定要结这批」，允许并存只会让确认时互相抢额度。
CREATE UNIQUE INDEX settlement_batches_supplier_period_key ON public.settlement_batches (organization_id, supplier_id, period_start)
WHERE
  status <> 'cancelled';


CREATE INDEX settlement_batches_status_index ON public.settlement_batches (organization_id, status, period_start DESC);


CREATE TABLE public.settlement_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payable_id uuid NOT NULL,
  -- 快照：应付行可以随订单编辑被删，凭证要能自己说明「结的是哪一笔」。
  order_number text NOT NULL,
  payable_name text NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  -- 非空即「已被某个已确认批次锁定」。作废批次时清空，额度随之释放。
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_items_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT settlement_items_batch_fk FOREIGN KEY (batch_id, organization_id) REFERENCES public.settlement_batches (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT settlement_items_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES public.orders (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT settlement_items_batch_payable_key UNIQUE (batch_id, payable_id)
);


CREATE INDEX settlement_items_batch_index ON public.settlement_items (batch_id);


CREATE INDEX settlement_items_payable_index ON public.settlement_items (organization_id, payable_id);


-- 读权限复用 finance.write：能发起结算的人才能看结算单。
-- 不新增 settlement.* 权限码 —— 结算与付款申请是同一件事的两个阶段，
-- 单独拆一个码只会让权限矩阵多两行而没有任何角色差异。
ALTER TABLE public.settlement_batches enable ROW level security;


ALTER TABLE public.settlement_items enable ROW level security;


REVOKE ALL ON public.settlement_batches,
public.settlement_items
FROM
  public,
  anon,
  authenticated;


GRANT
SELECT
  ON public.settlement_batches,
  public.settlement_items TO authenticated;


CREATE POLICY settlement_batches_select_reader ON public.settlement_batches FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('finance.write')
    )
  );


-- 明细的可见性顺着批次走，不自己再写一遍组织与权限规则（同 C5 游客名单）。
CREATE POLICY settlement_items_select_reader ON public.settlement_items FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('finance.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.settlement_batches AS parent_batch
      WHERE
        parent_batch.id = settlement_items.batch_id
    )
  );


-- 创建草稿批次。整批一次写入：先建批次再逐条加明细的写法，在进程被回收时会留下
-- 「有批次没明细」的半截数据，而这张表的总额恰恰是明细之和。
CREATE OR REPLACE FUNCTION public.create_settlement_batch (
  requested_supplier_id uuid,
  requested_period_start date,
  requested_method text,
  requested_note text,
  requested_items jsonb
) RETURNS TABLE (result_batch_id uuid, error_code text) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  item record;
  payable public.order_payables%ROWTYPE;
  order_number_snapshot text;
  settled_amount numeric(14, 2);
  seen_payables uuid[] := ARRAY[]::uuid[];
  new_batch_id uuid;
  batch_total numeric(14, 2) := 0;
  validated_items jsonb := '[]'::jsonb;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.has_permission ('finance.write')) THEN
    RAISE EXCEPTION 'finance.write is required' USING ERRCODE = '42501';
  END IF;

  IF requested_period_start IS NULL
    OR requested_period_start <> date_trunc('month', requested_period_start)::date THEN
    RETURN QUERY SELECT NULL::uuid, 'PERIOD_INVALID'::text;
    RETURN;
  END IF;

  IF requested_method NOT IN ('cash', 'bank', 'alipay', 'wechat', 'other') THEN
    RETURN QUERY SELECT NULL::uuid, 'METHOD_INVALID'::text;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.suppliers AS suppliers
    WHERE suppliers.id = requested_supplier_id
      AND suppliers.organization_id = current_org_id
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'SUPPLIER_NOT_FOUND'::text;
    RETURN;
  END IF;

  IF requested_items IS NULL
    OR jsonb_typeof(requested_items) <> 'array'
    OR jsonb_array_length(requested_items) = 0 THEN
    RETURN QUERY SELECT NULL::uuid, 'ITEMS_REQUIRED'::text;
    RETURN;
  END IF;

  -- 同月同供应商已有未作废批次：唯一索引也会报 23505，但先给一个可读的码，
  -- 用户看到的应该是「这个月已经开过批次」而不是「数据冲突」。
  IF EXISTS (
    SELECT 1
    FROM public.settlement_batches AS batches
    WHERE batches.organization_id = current_org_id
      AND batches.supplier_id = requested_supplier_id
      AND batches.period_start = requested_period_start
      AND batches.status <> 'cancelled'
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'BATCH_EXISTS'::text;
    RETURN;
  END IF;

  -- 先校验全部明细、按 payable_id 排序后逐条加锁：两个并发批次如果加锁顺序相反，
  -- 会互相等成死锁。批次本身最后才插入——任何一条校验失败都不能留下空草稿。
  FOR item IN
    SELECT
      (value ->> 'payableId')::uuid AS payable_id,
      (value ->> 'amount')::numeric AS amount
    FROM jsonb_array_elements(requested_items) AS value
    ORDER BY 1
  LOOP
    IF item.payable_id IS NULL OR item.amount IS NULL OR item.amount <= 0 THEN
      RETURN QUERY SELECT NULL::uuid, 'ITEM_INVALID'::text;
      RETURN;
    END IF;

    IF item.payable_id = ANY (seen_payables) THEN
      RETURN QUERY SELECT NULL::uuid, 'DUPLICATE_ITEM'::text;
      RETURN;
    END IF;

    seen_payables := seen_payables || item.payable_id;

    SELECT * INTO payable FROM public.order_payables AS payables
    WHERE payables.id = item.payable_id
      AND payables.organization_id = current_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, 'PAYABLE_NOT_FOUND'::text;
      RETURN;
    END IF;

    IF payable.supplier_id <> requested_supplier_id THEN
      RETURN QUERY SELECT NULL::uuid, 'SUPPLIER_MISMATCH'::text;
      RETURN;
    END IF;

    -- 累计口径：已确认结算的金额 + 本次金额不得超过应付总额。
    SELECT COALESCE(sum(items.amount), 0) INTO settled_amount
    FROM public.settlement_items AS items
    WHERE items.organization_id = current_org_id
      AND items.payable_id = item.payable_id
      AND items.confirmed_at IS NOT NULL;

    IF item.amount > payable.amount - settled_amount THEN
      RETURN QUERY SELECT NULL::uuid, 'AMOUNT_EXCEEDS_AVAILABLE'::text;
      RETURN;
    END IF;

    SELECT orders.order_number INTO order_number_snapshot
    FROM public.orders AS orders
    WHERE orders.id = payable.order_id
      AND orders.organization_id = current_org_id;

    validated_items := validated_items || jsonb_build_array(
      jsonb_build_object(
        'payableId', payable.id,
        'orderId', payable.order_id,
        'orderNumber', COALESCE(order_number_snapshot, ''),
        'payableName', payable.name,
        'amount', item.amount
      )
    );

    batch_total := batch_total + item.amount;
  END LOOP;

  INSERT INTO public.settlement_batches (
    organization_id, supplier_id, period_start, method, note, created_by
  ) VALUES (
    current_org_id, requested_supplier_id, requested_period_start,
    requested_method, requested_note, current_user_id
  ) RETURNING id INTO new_batch_id;

  INSERT INTO public.settlement_items (
    organization_id, batch_id, order_id, payable_id, order_number,
    payable_name, amount
  )
  SELECT
    current_org_id,
    new_batch_id,
    (value ->> 'orderId')::uuid,
    (value ->> 'payableId')::uuid,
    value ->> 'orderNumber',
    value ->> 'payableName',
    (value ->> 'amount')::numeric
  FROM jsonb_array_elements(validated_items) AS value;

  UPDATE public.settlement_batches AS batches
  SET total_amount = batch_total
  WHERE batches.id = new_batch_id;

  RETURN QUERY SELECT new_batch_id, NULL::text;
END;
$$;


-- 确认批次：这里才真正锁定额度。
-- 校验全部重做一遍，因为草稿可能放了几天，期间应付行被改过金额甚至改过供应商。
CREATE OR REPLACE FUNCTION public.confirm_settlement_batch (requested_batch_id uuid) RETURNS TABLE (
  new_status text,
  total_amount numeric,
  error_code text
) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  batch public.settlement_batches%ROWTYPE;
  item record;
  payable public.order_payables%ROWTYPE;
  settled_amount numeric(14, 2);
  sum_amount numeric(14, 2) := 0;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.has_permission ('finance.write')) THEN
    RAISE EXCEPTION 'finance.write is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO batch FROM public.settlement_batches AS batches
  WHERE batches.id = requested_batch_id
    AND batches.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::numeric, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF batch.status <> 'draft' THEN
    RETURN QUERY SELECT batch.status, batch.total_amount, 'STATE_CONFLICT'::text;
    RETURN;
  END IF;

  FOR item IN
    SELECT items.id, items.payable_id, items.amount
    FROM public.settlement_items AS items
    WHERE items.batch_id = batch.id
    ORDER BY items.payable_id
  LOOP
    SELECT * INTO payable FROM public.order_payables AS payables
    WHERE payables.id = item.payable_id
      AND payables.organization_id = current_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN QUERY SELECT batch.status, batch.total_amount, 'PAYABLE_NOT_FOUND'::text;
      RETURN;
    END IF;

    IF payable.supplier_id <> batch.supplier_id THEN
      RETURN QUERY SELECT batch.status, batch.total_amount, 'SUPPLIER_MISMATCH'::text;
      RETURN;
    END IF;

    SELECT COALESCE(sum(items.amount), 0) INTO settled_amount
    FROM public.settlement_items AS items
    WHERE items.organization_id = current_org_id
      AND items.payable_id = item.payable_id
      AND items.confirmed_at IS NOT NULL;

    IF item.amount > payable.amount - settled_amount THEN
      RETURN QUERY SELECT batch.status, batch.total_amount, 'AMOUNT_EXCEEDS_AVAILABLE'::text;
      RETURN;
    END IF;

    sum_amount := sum_amount + item.amount;
  END LOOP;

  IF sum_amount = 0 THEN
    RETURN QUERY SELECT batch.status, batch.total_amount, 'EMPTY_BATCH'::text;
    RETURN;
  END IF;

  UPDATE public.settlement_items AS items
  SET confirmed_at = now()
  WHERE items.batch_id = batch.id;

  UPDATE public.settlement_batches AS batches
  SET
    status = 'confirmed',
    total_amount = sum_amount,
    confirmed_by = current_user_id,
    confirmed_at = now(),
    updated_at = now()
  WHERE batches.id = batch.id;

  RETURN QUERY SELECT 'confirmed'::text, sum_amount, NULL::text;
END;
$$;


-- 作废批次。
-- 草稿作废只需 finance.write（本来就是自己刚起的草稿）；
-- 已确认批次作废是在撤销一次已生效的结算，要求 finance.approve，
-- 并强制填原因 —— 这条记录日后要回答「为什么这批结算没了」。
CREATE OR REPLACE FUNCTION public.cancel_settlement_batch (requested_batch_id uuid, requested_reason text) RETURNS TABLE (new_status text, error_code text) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  batch public.settlement_batches%ROWTYPE;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.has_permission ('finance.write')) THEN
    RAISE EXCEPTION 'finance.write is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO batch FROM public.settlement_batches AS batches
  WHERE batches.id = requested_batch_id
    AND batches.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF batch.status = 'cancelled' THEN
    RETURN QUERY SELECT 'cancelled'::text, 'STATE_CONFLICT'::text;
    RETURN;
  END IF;

  IF batch.status = 'confirmed' THEN
    IF NOT (SELECT public.has_permission ('finance.approve')) THEN
      RAISE EXCEPTION 'finance.approve is required' USING ERRCODE = '42501';
    END IF;

    IF requested_reason IS NULL OR length(btrim(requested_reason)) = 0 THEN
      RETURN QUERY SELECT batch.status, 'REASON_REQUIRED'::text;
      RETURN;
    END IF;
  END IF;

  -- 作废即释放额度：清掉锁定标记，累计口径随之回落。
  UPDATE public.settlement_items AS items
  SET confirmed_at = NULL
  WHERE items.batch_id = batch.id;

  UPDATE public.settlement_batches AS batches
  SET
    status = 'cancelled',
    cancelled_by = current_user_id,
    cancelled_at = now(),
    cancel_reason = requested_reason,
    updated_at = now()
  WHERE batches.id = batch.id;

  RETURN QUERY SELECT 'cancelled'::text, NULL::text;
END;
$$;


-- 默认 PUBLIC 持有 EXECUTE。不收回的话，这套「只走函数写」的设计等于没做。
REVOKE ALL ON FUNCTION public.create_settlement_batch (uuid, date, text, text, jsonb)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.confirm_settlement_batch (uuid)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.cancel_settlement_batch (uuid, text)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.create_settlement_batch (uuid, date, text, text, jsonb) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.confirm_settlement_batch (uuid) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.cancel_settlement_batch (uuid, text) TO authenticated;