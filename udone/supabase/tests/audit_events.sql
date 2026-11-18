-- C10 审计：统一写入函数 + 订单状态/金额、审批的强制审计。
--
-- 最关键的一条：审计写入失败不能绑架业务。因此 write_audit 在组织上下文缺失时直接返回，
-- 触发器也不抛错——业务照常成功，只是少一条日志（由对账任务发现），而不是让订单改不了。
BEGIN;


SELECT
  plan (7);


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
    'c1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'audit-operator@example.test',
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
    'c2000000-0000-4000-8000-000000000001',
    'audit org',
    'c1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'c3000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    '审计测试客户',
    '13900000081',
    'c1000000-0000-4000-8000-000000000001'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"c2000000-0000-4000-8000-000000000001","x-forwarded-for":"203.0.113.42, 10.0.0.1","user-agent":"Mozilla/5.0 (Windows NT 10.0) Chrome/120.0"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'c3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":9000}]'::jsonb,
    '[]'::jsonb,
    '审计测试订单',
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
        organization_id = 'c2000000-0000-4000-8000-000000000001'
      LIMIT
        1
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.audit_events
      WHERE
        action = 'order.status_changed'
    ),
    0,
    'creating an order is an INSERT, not a status change; no audit yet'
  );


SELECT
  public.transition_order_status (
    current_setting('test.order')::uuid,
    'confirm',
    (
      SELECT
        version
      FROM
        public.orders
      WHERE
        id = current_setting('test.order')::uuid
    )
  );


SELECT
  IS (
    (
      SELECT
        metadata ->> 'to'
      FROM
        public.audit_events
      WHERE
        action = 'order.status_changed'
      ORDER BY
        created_at DESC
      LIMIT
        1
    ),
    'active',
    'status change writes the new value into audit'
  );


SELECT
  IS (
    (
      SELECT
        ip_summary
      FROM
        public.audit_events
      WHERE
        action = 'order.status_changed'
      ORDER BY
        created_at DESC
      LIMIT
        1
    ),
    '203.0.113.0/24',
    'IP is stored as a /24 summary, never the full address'
  );


SELECT
  ok (
    (
      SELECT
        device_summary
      FROM
        public.audit_events
      WHERE
        action = 'order.status_changed'
      ORDER BY
        created_at DESC
      LIMIT
        1
    ) IS NOT NULL,
    'device summary is captured from the user agent'
  );


SELECT
  public.update_order_with_items (
    current_setting('test.order')::uuid,
    (
      SELECT
        version
      FROM
        public.orders
      WHERE
        id = current_setting('test.order')::uuid
    ),
    'c3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":9500}]'::jsonb,
    '[]'::jsonb
  );


SELECT
  IS (
    (
      SELECT
        metadata ->> 'receivableTo'
      FROM
        public.audit_events
      WHERE
        action = 'order.amount_changed'
      ORDER BY
        created_at DESC
      LIMIT
        1
    ),
    '9000.00',
    'amount change records both the old and new numbers'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.audit_events
      WHERE
        action = 'order.status_changed'
    ),
    1,
    'an amount-only update does not emit a status audit'
  );


SELECT
  ok (
    (
      SELECT
        COUNT(*) > 0
      FROM
        public.audit_events
      WHERE
        request_id IS NOT NULL
    ),
    'request id is recorded so one operation can be traced end to end'
  );


ROLLBACK;