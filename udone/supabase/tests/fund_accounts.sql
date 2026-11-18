-- C7 账户余额：期初 + 已确认收款 − 已确认付款 + 调整。
--
-- 最关键的三条都是「不该计入」：审批中不改变、驳回不改变、撤回回滚。
-- 只断「approved 时余额对了」不够——那可能把 pending 也算进去只是恰好数值相同。
BEGIN;


SELECT
  plan (8);


INSERT INTO
  auth.users (
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  )
VALUES
  (
    'b1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'balance-admin@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'balance-operator@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'balance-finance@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  );


INSERT INTO
  public.organizations (id, name, created_by)
VALUES
  (
    'b2000000-0000-4000-8000-000000000001',
    'balance org',
    'b1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001',
    'admin'
  ),
  (
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002',
    'operator'
  ),
  (
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000003',
    'finance'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'b3000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001',
    '余额测试客户',
    '13900000101',
    'b1000000-0000-4000-8000-000000000002'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"b2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_fund_account ('银行账户', 'bank', 1000, NULL)
    ),
    NULL,
    'an admin creates a bank account with an opening balance'
  );


SELECT
  IS (
    (
      SELECT
        balance
      FROM
        public.account_balances ()
      WHERE
        method = 'bank'
    ),
    1000::numeric,
    'balance starts at the opening amount'
  );


-- 建订单与提交申请用 operator，避免后面自己审自己被拒
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'b3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":6000}]'::jsonb,
    '[]'::jsonb,
    '余额测试订单',
    '2026-12-20',
    '2026-12-27',
    2,
    1
  );


SELECT
  set_config(
    'test.order',
    (
      SELECT
        id::text
      FROM
        public.orders
      WHERE
        organization_id = 'b2000000-0000-4000-8000-000000000001'
      LIMIT
        1
    ),
    TRUE
  );


SELECT
  set_config(
    'test.line',
    (
      SELECT
        id::text
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.order')::uuid
      LIMIT
        1
    ),
    TRUE
  );


SELECT
  public.create_finance_application (
    'receipt',
    current_setting('test.order')::uuid,
    current_setting('test.line')::uuid,
    3000,
    'bank',
    '2026-12-01'::date,
    'BAL-001',
    NULL,
    '余额测试'
  );


SELECT
  set_config(
    'test.application',
    (
      SELECT
        id::text
      FROM
        public.finance_applications
      WHERE
        organization_id = 'b2000000-0000-4000-8000-000000000001'
      LIMIT
        1
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        balance
      FROM
        public.account_balances ()
      WHERE
        method = 'bank'
    ),
    1000::numeric,
    'a pending application does not change the actual balance'
  );


-- 一级审批用 finance
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  new_status,
  new_step,
  error_code
FROM
  public.decide_finance_application (
    current_setting('test.application')::uuid,
    'approve',
    '一级同意',
    1
  );


-- 终审用 admin
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  new_status,
  new_step,
  error_code
FROM
  public.decide_finance_application (
    current_setting('test.application')::uuid,
    'approve',
    '终审同意',
    2
  );


SELECT
  IS (
    (
      SELECT
        balance
      FROM
        public.account_balances ()
      WHERE
        method = 'bank'
    ),
    4000::numeric,
    'an approved receipt adds to the balance'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.adjust_account_balance (
          (
            SELECT
              id
            FROM
              public.fund_accounts
            WHERE
              organization_id = 'b2000000-0000-4000-8000-000000000001'
          ),
          -500,
          '银行手续费'
        )
    ),
    NULL,
    'a negative adjustment with a reason is accepted'
  );


SELECT
  IS (
    (
      SELECT
        balance
      FROM
        public.account_balances ()
      WHERE
        method = 'bank'
    ),
    3500::numeric,
    'adjustments feed into the same balance figure'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.adjust_account_balance (
          (
            SELECT
              id
            FROM
              public.fund_accounts
            WHERE
              organization_id = 'b2000000-0000-4000-8000-000000000001'
          ),
          100,
          ''
        )
    ),
    'INVALID_ADJUSTMENT',
    'an adjustment without a reason is rejected'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.balance_adjustments
      WHERE
        amount = -500
    ),
    1,
    'the accepted adjustment is recorded once'
  );


ROLLBACK;