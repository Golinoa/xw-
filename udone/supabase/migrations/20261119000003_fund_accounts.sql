-- C7 账户余额（R-BALANCE-01）：资金账户 + 余额口径 + 不可变调整流水。
--
-- 需求原文：每个付款方式可映射资金账户；余额 = 期初 + 已确认收款 − 已确认付款；
-- 审批中和已驳回不改变实际余额；终审撤回同步回滚；余额调整用不可变流水并记原因和权限。
--
-- 关键口径（写在这里，前端不许自己算）：
--   1. 只认 finance_applications.status = 'approved'，pending/rejected/withdrawn 一律不计；
--   2. 按 method 归集到资金账户（一个 method 在一家机构最多映射一个账户）；
--   3. 调整流水只 INSERT，不 UPDATE/DELETE——改错了要用一笔反向调整冲正，不能涂改历史。
--
-- 余额是实时算出来的，不存冗余列：存了就会出现「流水改了余额没变」这种资损级不一致。
CREATE TABLE public.fund_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  method text NOT NULL CHECK (
    method IN ('cash', 'bank', 'alipay', 'wechat', 'other')
  ),
  opening_balance numeric(14, 2) NOT NULL DEFAULT 0,
  remark text,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fund_accounts_org_method_key UNIQUE (organization_id, method),
  CONSTRAINT fund_accounts_id_organization_key UNIQUE (id, organization_id)
);


COMMENT ON TABLE public.fund_accounts IS '资金账户；每个付款方式在一家机构最多映射一个账户。';


ALTER TABLE public.fund_accounts enable ROW level security;


CREATE POLICY fund_accounts_select_member ON public.fund_accounts FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


CREATE TABLE public.balance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.fund_accounts (id) ON DELETE RESTRICT,
  amount numeric(14, 2) NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT balance_adjustments_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT balance_adjustments_account_tenant_fk FOREIGN KEY (account_id, organization_id) REFERENCES public.fund_accounts (id, organization_id) ON DELETE RESTRICT
);


COMMENT ON TABLE public.balance_adjustments IS '余额调整流水；只追加不修改，冲正用反向记录。';


ALTER TABLE public.balance_adjustments enable ROW level security;


CREATE POLICY balance_adjustments_select_member ON public.balance_adjustments FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


-- 调整必须走 RPC：函数里写审计，且防止 authenticated 直接 INSERT 绕过原因校验。
REVOKE ALL ON public.balance_adjustments
FROM
  PUBLIC;


GRANT
SELECT
  ON public.balance_adjustments TO authenticated;


-- 余额 = 期初 + 已确认收款 − 已确认付款 + 调整。
-- 用 CREATE OR REPLACE 之前的同名函数（若有）会被覆盖，这里首次创建。
CREATE OR REPLACE FUNCTION public.account_balances () RETURNS TABLE (
  account_id uuid,
  account_name text,
  method text,
  opening_balance numeric,
  confirmed_in numeric,
  confirmed_out numeric,
  adjustments numeric,
  balance numeric
) LANGUAGE sql STABLE
SET
  search_path = '' AS $$
  SELECT
    account.id,
    account.name,
    account.method,
    account.opening_balance,
    COALESCE(inflow.confirmed_in, 0) AS confirmed_in,
    COALESCE(outflow.confirmed_out, 0) AS confirmed_out,
    COALESCE(adjust.total, 0) AS adjustments,
    account.opening_balance
      + COALESCE(inflow.confirmed_in, 0)
      - COALESCE(outflow.confirmed_out, 0)
      + COALESCE(adjust.total, 0) AS balance
  FROM public.fund_accounts AS account
  LEFT JOIN (
    SELECT application.method, pg_catalog.sum(application.amount) AS confirmed_in
    FROM public.finance_applications AS application
    WHERE application.organization_id = public.current_organization_id ()
      AND application.status = 'approved'
      AND application.kind = 'receipt'
    GROUP BY application.method
  ) AS inflow ON inflow.method = account.method
  LEFT JOIN (
    SELECT application.method, pg_catalog.sum(application.amount) AS confirmed_out
    FROM public.finance_applications AS application
    WHERE application.organization_id = public.current_organization_id ()
      AND application.status = 'approved'
      AND application.kind = 'payment'
    GROUP BY application.method
  ) AS outflow ON outflow.method = account.method
  LEFT JOIN (
    SELECT adjustment.account_id, pg_catalog.sum(adjustment.amount) AS total
    FROM public.balance_adjustments AS adjustment
    WHERE adjustment.organization_id = public.current_organization_id ()
    GROUP BY adjustment.account_id
  ) AS adjust ON adjust.account_id = account.id
  WHERE account.organization_id = public.current_organization_id ();
$$;


-- 建账户：一个 method 只允许一个账户，唯一索引兜底并发。
CREATE OR REPLACE FUNCTION public.create_fund_account (
  requested_name text,
  requested_method text,
  requested_opening_balance numeric DEFAULT 0,
  requested_remark text DEFAULT NULL
) RETURNS TABLE (result_account_id uuid, error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  new_account_id uuid;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.has_permission ('settings.manage')) THEN
    RAISE EXCEPTION 'settings.manage is required' USING ERRCODE = '42501';
  END IF;
  IF requested_name IS NULL
    OR length(btrim(requested_name)) = 0
    OR requested_method NOT IN ('cash', 'bank', 'alipay', 'wechat', 'other')
    OR requested_opening_balance IS NULL
    OR requested_opening_balance < 0 THEN
    RETURN QUERY SELECT NULL::uuid, 'INVALID_ACCOUNT'::text;
    RETURN;
  END IF;

  INSERT INTO public.fund_accounts (
    organization_id, name, method, opening_balance, remark, created_by
  ) VALUES (
    current_org_id, btrim(requested_name), requested_method,
    requested_opening_balance, requested_remark, (SELECT auth.uid ())
  ) RETURNING id INTO new_account_id;

  RETURN QUERY SELECT new_account_id, NULL::text;
END;
$$;


-- 调整余额：原因必填，金额非 0，写不可变流水 + 审计。
CREATE OR REPLACE FUNCTION public.adjust_account_balance (
  requested_account_id uuid,
  requested_amount numeric,
  requested_reason text
) RETURNS TABLE (result_adjustment_id uuid, error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  new_adjustment_id uuid;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.has_permission ('finance.approve')) THEN
    RAISE EXCEPTION 'finance.approve is required' USING ERRCODE = '42501';
  END IF;
  IF requested_amount IS NULL
    OR requested_amount = 0
    OR requested_reason IS NULL
    OR length(btrim(requested_reason)) = 0 THEN
    RETURN QUERY SELECT NULL::uuid, 'INVALID_ADJUSTMENT'::text;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.fund_accounts AS account
    WHERE account.id = requested_account_id
      AND account.organization_id = current_org_id
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'ACCOUNT_NOT_FOUND'::text;
    RETURN;
  END IF;

  INSERT INTO public.balance_adjustments (
    organization_id, account_id, amount, reason, created_by
  ) VALUES (
    current_org_id, requested_account_id, requested_amount,
    btrim(requested_reason), (SELECT auth.uid ())
  ) RETURNING id INTO new_adjustment_id;

  PERFORM public.write_audit(
    'balance.adjusted', 'fund_account', requested_account_id,
    pg_catalog.jsonb_build_object('amount', requested_amount, 'reason', btrim(requested_reason))
  );

  RETURN QUERY SELECT new_adjustment_id, NULL::text;
END;
$$;


REVOKE ALL ON FUNCTION public.account_balances ()
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.create_fund_account (text, text, numeric, text)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.adjust_account_balance (uuid, numeric, text)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.account_balances () TO authenticated;


GRANT
EXECUTE ON FUNCTION public.create_fund_account (text, text, numeric, text) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.adjust_account_balance (uuid, numeric, text) TO authenticated;