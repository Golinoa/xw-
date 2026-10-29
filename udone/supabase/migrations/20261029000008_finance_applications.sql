-- 收付款申请与审批（R-FIN-02 / R-FIN-03 / R-APPROVAL-02）。
--
-- 这一层的核心不变式是「额度只能被占一次」：
--   amount = confirmed_amount + pending_amount + available_amount（生成列）
--   order_* 表的 CHECK (confirmed + pending <= amount) 已经是硬约束，
--   函数再在写入前做一次可读校验，把约束违反转成项目级错误码。
--
-- 待审占用额度但不计入已收：申请创建时 pending_amount += amount，终审通过才
-- pending -= amount / confirmed += amount，驳回或撤销只释放 pending。这样
-- 「在途金额」和「已收金额」始终是两个不同的数，报表才不会把待审当收入（R-REPORT-01）。
--
-- 表统一而不是拆两张：收款和付款的字段与状态机完全对称，拆表只会让审批逻辑
-- 写两遍。用 kind + 两个可空外键 + CHECK 保证二者互斥，复合外键保证申请引用的
-- 明细行必须属于同一张订单，跨订单或跨租户引用在数据库层就不成立。
--
-- 已知范围限制（诚实记录）：
-- 1. 审批级次写死两级（财务 → 管理员），R-APPROVAL-01 的流程配置表尚未实现；
--    配置项「是否允许撤回」「是否允许同人审批自己的申请」未做成开关，当前固定为
--    「允许创建人撤销待审申请」+「禁止同人审批自己的申请」。
-- 2. 申请与审批动作只写入本表，未接入站内通知（R-NOTIFY-01）。
-- 3. 客户端不持有本表的任何写权限：写入只能经过下面的函数，否则直接 PATCH
--    状态就能把待审申请改成已确认，额度校验形同虚设。
ALTER TABLE public.order_receivables
ADD CONSTRAINT order_receivables_id_order_key UNIQUE (id, order_id);


ALTER TABLE public.order_payables
ADD CONSTRAINT order_payables_id_order_key UNIQUE (id, order_id);


CREATE TABLE public.finance_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('receipt', 'payment')),
  order_id uuid NOT NULL,
  receivable_id uuid,
  payable_id uuid,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (
    method IN ('cash', 'bank', 'alipay', 'wechat', 'other')
  ),
  occurred_on date NOT NULL,
  reference_no text CHECK (
    reference_no IS NULL
    OR length(btrim(reference_no)) BETWEEN 1 AND 64
  ),
  voucher_url text CHECK (
    voucher_url IS NULL
    OR length(btrim(voucher_url)) BETWEEN 1 AND 500
  ),
  remark text CHECK (
    remark IS NULL
    OR length(remark) <= 500
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'withdrawn')
  ),
  current_step integer NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 2),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_applications_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT finance_applications_line_exclusive CHECK (
    (
      kind = 'receipt'
      AND receivable_id IS NOT NULL
      AND payable_id IS NULL
    )
    OR (
      kind = 'payment'
      AND payable_id IS NOT NULL
      AND receivable_id IS NULL
    )
  ),
  CONSTRAINT finance_applications_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES public.orders (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT finance_applications_receivable_fk FOREIGN KEY (receivable_id, order_id) REFERENCES public.order_receivables (id, order_id) ON DELETE CASCADE,
  CONSTRAINT finance_applications_payable_fk FOREIGN KEY (payable_id, order_id) REFERENCES public.order_payables (id, order_id) ON DELETE CASCADE
);


CREATE INDEX finance_applications_order_index ON public.finance_applications (organization_id, order_id, status);


CREATE INDEX finance_applications_pending_index ON public.finance_applications (organization_id, status, created_at DESC);


-- 审批轨迹。每次动作记一行，保留级次、操作者、意见和前后状态（R-APPROVAL-02）。
-- 这张表只追加，不改不删：状态回退靠新增一条动作记录表达，而不是覆盖历史。
CREATE TABLE public.finance_application_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  application_id uuid NOT NULL,
  step integer NOT NULL CHECK (step BETWEEN 1 AND 2),
  action text NOT NULL CHECK (
    action IN ('approve', 'reject', 'withdraw', 'undo')
  ),
  actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  opinion text CHECK (
    opinion IS NULL
    OR length(opinion) <= 500
  ),
  from_status text NOT NULL,
  to_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_application_actions_application_fk FOREIGN KEY (application_id, organization_id) REFERENCES public.finance_applications (id, organization_id) ON DELETE CASCADE
);


CREATE INDEX finance_application_actions_application_index ON public.finance_application_actions (application_id, created_at);


INSERT INTO
  public.organization_role_permissions (role, permission)
VALUES
  ('admin', 'finance.write'),
  ('admin', 'finance.approve'),
  ('operator', 'finance.write'),
  ('finance', 'finance.write'),
  ('finance', 'finance.approve')
ON CONFLICT (role, permission) DO NOTHING;


ALTER TABLE public.finance_applications enable ROW level security;


ALTER TABLE public.finance_application_actions enable ROW level security;


-- 读策略沿用明细表的写法：顺父订单判定，自动继承 orders 的 own/all 数据范围。
-- 写权限不授予 authenticated，只通过函数写入。
CREATE POLICY finance_applications_select_reader ON public.finance_applications FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.read')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = finance_applications.order_id
    )
  );


CREATE POLICY finance_application_actions_select_reader ON public.finance_application_actions FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.read')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.finance_applications AS parent_application
      WHERE
        parent_application.id = finance_application_actions.application_id
    )
  );


-- 额度调整只做「把申请上的金额搬来搬去」这一件事，本身不做任何校验：
-- 调用者必须已经在锁住申请行的事务里。因此这三个函数不授予 authenticated 执行权，
-- 否则客户端可以绕过状态机，直接把 confirmed_amount 改成任意值。
CREATE OR REPLACE FUNCTION public.release_finance_application_hold (requested_application_id uuid) RETURNS void LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  application public.finance_applications%ROWTYPE;
BEGIN
  SELECT * INTO application FROM public.finance_applications AS applications
  WHERE applications.id = requested_application_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'application not found' USING ERRCODE = 'P0002';
  END IF;

  IF application.kind = 'receipt' THEN
    UPDATE public.order_receivables
    SET pending_amount = greatest(pending_amount - application.amount, 0), updated_at = now ()
    WHERE id = application.receivable_id;
  ELSE
    UPDATE public.order_payables
    SET pending_amount = greatest(pending_amount - application.amount, 0), updated_at = now ()
    WHERE id = application.payable_id;
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.confirm_finance_application_hold (requested_application_id uuid) RETURNS void LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  application public.finance_applications%ROWTYPE;
BEGIN
  SELECT * INTO application FROM public.finance_applications AS applications
  WHERE applications.id = requested_application_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'application not found' USING ERRCODE = 'P0002';
  END IF;

  IF application.kind = 'receipt' THEN
    UPDATE public.order_receivables
    SET
      pending_amount = greatest(pending_amount - application.amount, 0),
      confirmed_amount = confirmed_amount + application.amount,
      updated_at = now ()
    WHERE id = application.receivable_id;
  ELSE
    UPDATE public.order_payables
    SET
      pending_amount = greatest(pending_amount - application.amount, 0),
      confirmed_amount = confirmed_amount + application.amount,
      updated_at = now ()
    WHERE id = application.payable_id;
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.release_finance_application_confirm (requested_application_id uuid) RETURNS void LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  application public.finance_applications%ROWTYPE;
BEGIN
  SELECT * INTO application FROM public.finance_applications AS applications
  WHERE applications.id = requested_application_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'application not found' USING ERRCODE = 'P0002';
  END IF;

  -- 确认金额退回在途后仍占用额度：撤回审批不等于放弃收款，
  -- 所以这里不是把金额还回 available_amount。
  IF application.kind = 'receipt' THEN
    UPDATE public.order_receivables
    SET
      confirmed_amount = greatest(confirmed_amount - application.amount, 0),
      pending_amount = pending_amount + application.amount,
      updated_at = now ()
    WHERE id = application.receivable_id;
  ELSE
    UPDATE public.order_payables
    SET
      confirmed_amount = greatest(confirmed_amount - application.amount, 0),
      pending_amount = pending_amount + application.amount,
      updated_at = now ()
    WHERE id = application.payable_id;
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.create_finance_application (
  requested_kind text,
  requested_order_id uuid,
  requested_line_id uuid,
  requested_amount numeric,
  requested_method text,
  requested_occurred_on date,
  requested_reference_no text DEFAULT NULL,
  requested_voucher_url text DEFAULT NULL,
  requested_remark text DEFAULT NULL
) RETURNS TABLE (result_application_id uuid, error_code text) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  target_order public.orders%ROWTYPE;
  available numeric(14, 2);
  new_application_id uuid;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.has_permission ('finance.write')) THEN
    RAISE EXCEPTION 'finance.write is required' USING ERRCODE = '42501';
  END IF;

  IF requested_amount IS NULL OR requested_amount <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 'AMOUNT_INVALID'::text;
    RETURN;
  END IF;

  SELECT * INTO target_order FROM public.orders AS orders
  WHERE orders.id = requested_order_id
    AND orders.organization_id = current_org_id
    AND orders.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'ORDER_NOT_FOUND'::text;
    RETURN;
  END IF;

  -- 已取消的订单不再产生资金流动。已锁团（completed）允许：尾款在出团后结
  -- 是常态，锁团约束的是改价，不是收款。
  IF target_order.status = 'cancelled' THEN
    RETURN QUERY SELECT NULL::uuid, 'ORDER_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  IF requested_kind = 'receipt' THEN
    -- FOR UPDATE 是并发正确性的关键：两个事务同时申请同一行时，
    -- 后者要等前者提交后重新读到已占用的 pending_amount，才会被额度校验挡住。
    SELECT receivables.available_amount INTO available
    FROM public.order_receivables AS receivables
    WHERE receivables.id = requested_line_id
      AND receivables.order_id = requested_order_id
      AND receivables.organization_id = current_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, 'LINE_NOT_FOUND'::text;
      RETURN;
    END IF;

    IF requested_amount > available THEN
      RETURN QUERY SELECT NULL::uuid, 'AMOUNT_EXCEEDS_AVAILABLE'::text;
      RETURN;
    END IF;

    INSERT INTO public.finance_applications (
      organization_id, kind, order_id, receivable_id, amount, method,
      occurred_on, reference_no, voucher_url, remark, created_by, updated_by
    ) VALUES (
      current_org_id, 'receipt', requested_order_id, requested_line_id,
      requested_amount, requested_method, requested_occurred_on,
      requested_reference_no, requested_voucher_url, requested_remark,
      current_user_id, current_user_id
    ) RETURNING id INTO new_application_id;

    UPDATE public.order_receivables
    SET pending_amount = pending_amount + requested_amount, updated_at = now ()
    WHERE id = requested_line_id;

  ELSIF requested_kind = 'payment' THEN
    SELECT payables.available_amount INTO available
    FROM public.order_payables AS payables
    WHERE payables.id = requested_line_id
      AND payables.order_id = requested_order_id
      AND payables.organization_id = current_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, 'LINE_NOT_FOUND'::text;
      RETURN;
    END IF;

    IF requested_amount > available THEN
      RETURN QUERY SELECT NULL::uuid, 'AMOUNT_EXCEEDS_AVAILABLE'::text;
      RETURN;
    END IF;

    INSERT INTO public.finance_applications (
      organization_id, kind, order_id, payable_id, amount, method,
      occurred_on, reference_no, voucher_url, remark, created_by, updated_by
    ) VALUES (
      current_org_id, 'payment', requested_order_id, requested_line_id,
      requested_amount, requested_method, requested_occurred_on,
      requested_reference_no, requested_voucher_url, requested_remark,
      current_user_id, current_user_id
    ) RETURNING id INTO new_application_id;

    UPDATE public.order_payables
    SET pending_amount = pending_amount + requested_amount, updated_at = now ()
    WHERE id = requested_line_id;

  ELSE
    RETURN QUERY SELECT NULL::uuid, 'KIND_INVALID'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT new_application_id, NULL::text;
END;
$$;


CREATE OR REPLACE FUNCTION public.decide_finance_application (
  requested_application_id uuid,
  requested_action text,
  requested_opinion text,
  requested_version integer
) RETURNS TABLE (
  new_status text,
  new_step integer,
  error_code text
) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  application public.finance_applications%ROWTYPE;
  target_status text;
  target_step integer;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.has_permission ('finance.approve')) THEN
    RAISE EXCEPTION 'finance.approve is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO application FROM public.finance_applications AS applications
  WHERE applications.id = requested_application_id
    AND applications.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF application.version <> requested_version THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  IF application.status <> 'pending' THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'APPLICATION_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  -- 同级自顾是审批流最常见的失效方式，这里硬编码禁止。
  -- R-APPROVAL-01 的「是否允许同人审批」配置项落地后再改成开关。
  IF application.created_by = current_user_id THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'SELF_APPROVAL_FORBIDDEN'::text;
    RETURN;
  END IF;

  IF requested_action = 'reject' THEN
    IF requested_opinion IS NULL OR length(btrim(requested_opinion)) = 0 THEN
      RETURN QUERY SELECT NULL::text, NULL::integer, 'REASON_REQUIRED'::text;
      RETURN;
    END IF;

    target_status := 'rejected';
    target_step := application.current_step;

    PERFORM public.release_finance_application_hold (application.id);

  ELSIF requested_action = 'approve' THEN
    -- 第二级要求管理员级权限。这是硬编码的近似，等流程配置表落地后由配置决定。
    IF application.current_step = 2
      AND NOT (SELECT public.has_permission ('settings.manage')) THEN
      RAISE EXCEPTION 'the final step requires an administrator' USING ERRCODE = '42501';
    END IF;

    IF application.current_step < 2 THEN
      -- 前级通过：状态仍是待审，只是推进到下一级，额度继续占用。
      target_status := 'pending';
      target_step := application.current_step + 1;
    ELSE
      target_status := 'approved';
      target_step := application.current_step;
      PERFORM public.confirm_finance_application_hold (application.id);
    END IF;
  ELSE
    RETURN QUERY SELECT NULL::text, NULL::integer, 'ACTION_INVALID'::text;
    RETURN;
  END IF;

  UPDATE public.finance_applications AS applications
  SET
    status = target_status,
    current_step = target_step,
    version = application.version + 1,
    updated_by = current_user_id,
    updated_at = now ()
  WHERE applications.id = application.id;

  INSERT INTO public.finance_application_actions (
    organization_id, application_id, step, action, actor_id, opinion,
    from_status, to_status
  ) VALUES (
    current_org_id, application.id, application.current_step,
    requested_action, current_user_id, requested_opinion,
    application.status, target_status
  );

  RETURN QUERY SELECT target_status, target_step, NULL::text;
END;
$$;


-- 终审撤回：把已确认的金额退回在途，并回到终审待办（R-APPROVAL-02）。
-- 前级审批记录保留，不重放。
CREATE OR REPLACE FUNCTION public.undo_finance_application (
  requested_application_id uuid,
  requested_reason text,
  requested_version integer
) RETURNS TABLE (new_status text, error_code text) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  application public.finance_applications%ROWTYPE;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.has_permission ('finance.approve'))
    OR NOT (SELECT public.has_permission ('settings.manage')) THEN
    RAISE EXCEPTION 'undoing a final approval requires an administrator' USING ERRCODE = '42501';
  END IF;

  IF requested_reason IS NULL OR length(btrim(requested_reason)) = 0 THEN
    RETURN QUERY SELECT NULL::text, 'REASON_REQUIRED'::text;
    RETURN;
  END IF;

  SELECT * INTO application FROM public.finance_applications AS applications
  WHERE applications.id = requested_application_id
    AND applications.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF application.version <> requested_version THEN
    RETURN QUERY SELECT NULL::text, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  IF application.status <> 'approved' THEN
    RETURN QUERY SELECT NULL::text, 'APPLICATION_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  PERFORM public.release_finance_application_confirm (application.id);

  UPDATE public.finance_applications AS applications
  SET
    status = 'pending',
    current_step = 2,
    version = application.version + 1,
    updated_by = current_user_id,
    updated_at = now ()
  WHERE applications.id = application.id;

  INSERT INTO public.finance_application_actions (
    organization_id, application_id, step, action, actor_id, opinion,
    from_status, to_status
  ) VALUES (
    current_org_id, application.id, 2, 'undo', current_user_id,
    requested_reason, application.status, 'pending'
  );

  RETURN QUERY SELECT 'pending'::text, NULL::text;
END;
$$;


-- 创建人撤销尚未终审的申请：释放额度，不留状态回退余地。
CREATE OR REPLACE FUNCTION public.withdraw_finance_application (
  requested_application_id uuid,
  requested_reason text,
  requested_version integer
) RETURNS TABLE (new_status text, error_code text) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  application public.finance_applications%ROWTYPE;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO application FROM public.finance_applications AS applications
  WHERE applications.id = requested_application_id
    AND applications.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF application.created_by IS DISTINCT FROM current_user_id THEN
    RAISE EXCEPTION 'only the creator can withdraw an application' USING ERRCODE = '42501';
  END IF;

  IF application.version <> requested_version THEN
    RETURN QUERY SELECT NULL::text, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  IF application.status <> 'pending' THEN
    RETURN QUERY SELECT NULL::text, 'APPLICATION_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  IF requested_reason IS NULL OR length(btrim(requested_reason)) = 0 THEN
    RETURN QUERY SELECT NULL::text, 'REASON_REQUIRED'::text;
    RETURN;
  END IF;

  PERFORM public.release_finance_application_hold (application.id);

  UPDATE public.finance_applications AS applications
  SET
    status = 'withdrawn',
    version = application.version + 1,
    updated_by = current_user_id,
    updated_at = now ()
  WHERE applications.id = application.id;

  INSERT INTO public.finance_application_actions (
    organization_id, application_id, step, action, actor_id, opinion,
    from_status, to_status
  ) VALUES (
    current_org_id, application.id, application.current_step,
    'withdraw', current_user_id, requested_reason,
    application.status, 'withdrawn'
  );

  RETURN QUERY SELECT 'withdrawn'::text, NULL::text;
END;
$$;


-- 默认 PUBLIC 持有 EXECUTE，必须显式收回，否则这套函数等于没做权限控制。
-- 额度调整函数只给内部调用，客户端拿到执行权就能绕过整个状态机。
REVOKE ALL ON FUNCTION public.release_finance_application_hold (uuid)
FROM
  PUBLIC,
  authenticated;


REVOKE ALL ON FUNCTION public.confirm_finance_application_hold (uuid)
FROM
  PUBLIC,
  authenticated;


REVOKE ALL ON FUNCTION public.release_finance_application_confirm (uuid)
FROM
  PUBLIC,
  authenticated;


REVOKE ALL ON FUNCTION public.create_finance_application (
  text,
  uuid,
  uuid,
  numeric,
  text,
  date,
  text,
  text,
  text
)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.decide_finance_application (uuid, text, text, integer)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.undo_finance_application (uuid, text, integer)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.withdraw_finance_application (uuid, text, integer)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.create_finance_application (
  text,
  uuid,
  uuid,
  numeric,
  text,
  date,
  text,
  text,
  text
) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.decide_finance_application (uuid, text, text, integer) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.undo_finance_application (uuid, text, integer) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.withdraw_finance_application (uuid, text, integer) TO authenticated;