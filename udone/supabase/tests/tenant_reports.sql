-- C8 报表口径：创建日期过滤、cancelled 默认排除、在途与已确认分列。
--
-- 最关键的一条：两张报表函数必须基于同一订单范围。只断总览数字对不够——
-- 如果供应商统计用了别的日期字段，两个图表会给出矛盾的答案。
BEGIN;


SELECT
  plan (6);


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
    'c8000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'report-admin@example.test',
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
    'c9000000-0000-4000-8000-000000000001',
    'report org',
    'c8000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'c9000000-0000-4000-8000-000000000001',
    'c8000000-0000-4000-8000-000000000001',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'ca000000-0000-4000-8000-000000000001',
    'c9000000-0000-4000-8000-000000000001',
    '报表测试客户',
    '13900000111',
    'c8000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.suppliers (id, organization_id, name)
VALUES
  (
    'cb000000-0000-4000-8000-000000000001',
    'c9000000-0000-4000-8000-000000000001',
    '报表测试供应商'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"c9000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c8000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'ca000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":6000}]'::jsonb,
    '[{"name":"地接","amount":4000,"supplierId":"cb000000-0000-4000-8000-000000000001"}]'::jsonb,
    '报表测试订单',
    '2026-12-20',
    '2026-12-27',
    2,
    1
  );


SELECT
  IS (
    (
      SELECT
        public.tenant_report ((current_date - 1), (current_date + 1)) -> 'overview' ->> 'orderCount'
    ),
    '1',
    'an order in the date range is counted'
  );


SELECT
  IS (
    (
      SELECT
        public.tenant_report ((current_date + 60), (current_date + 90)) -> 'overview' ->> 'orderCount'
    ),
    '0',
    'an order outside the date range is not counted'
  );


SELECT
  IS (
    (
      SELECT
        public.tenant_report ((current_date - 1), (current_date + 1)) -> 'finance' ->> 'pendingIn'
    ),
    '0.00',
    'in-flight amounts are reported separately, defaulting to zero'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::integer
      FROM
        public.tenant_supplier_report ((current_date - 1), (current_date + 1))
    ),
    1,
    'the supplier report covers the same date range'
  );


SELECT
  IS (
    (
      SELECT
        payable_amount
      FROM
        public.tenant_supplier_report ((current_date - 1), (current_date + 1))
    ),
    4000::numeric,
    'supplier payable totals come from the same scoped orders'
  );


SELECT
  IS (
    (
      SELECT
        public.tenant_report ((current_date - 1), (current_date + 1)) -> 'overview' ->> 'receivableTotal'
    ),
    '6000.00',
    'overview receivable total is computed once by the shared function'
  );


ROLLBACK;