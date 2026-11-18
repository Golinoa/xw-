-- C9 站内通知：事务内写入 + 只本人可读 + 标记已读。
--
-- 最关键的一条：审批结果必须通知到申请人本人，且通知与状态变更在同一个事务里——
-- 只断「通知表有行」不够，那可能是别的测试残留；要按 recipient_id 精确对上申请人。
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
    'e1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'notify-applicant@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'e1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'notify-finance@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'e1000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'notify-admin@example.test',
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
    'e2000000-0000-4000-8000-000000000001',
    'notify org',
    'e1000000-0000-4000-8000-000000000003'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000002',
    'finance'
  ),
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000003',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'e3000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    '通知测试客户',
    '13900000091',
    'e1000000-0000-4000-8000-000000000001'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"e2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'e3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":6000}]'::jsonb,
    '[]'::jsonb,
    '通知测试订单',
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
        organization_id = 'e2000000-0000-4000-8000-000000000001'
      LIMIT
        1
    ),
    TRUE
  );


-- 申请人提交收款申请
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
    'NOTIFY-001',
    NULL,
    '通知测试'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.notifications
    ),
    0,
    'submitting an application does not yet notify anyone in this first cut'
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
        organization_id = 'e2000000-0000-4000-8000-000000000001'
      LIMIT
        1
    ),
    TRUE
  );


-- 切到财务身份做终审
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}',
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


-- 切到管理员做终审
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}',
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
        status
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.application')::uuid
    ),
    'approved',
    'the application reaches the approved state'
  );


SELECT
  IS (
    (
      SELECT
        created_by::text
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.application')::uuid
    ),
    'e1000000-0000-4000-8000-000000000001',
    'the applicant is recorded on the application'
  );


-- 通知受 RLS 保护，只有收件人本人能读；切回申请人身份验证
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        notification_type
      FROM
        public.notifications
      WHERE
        recipient_id = 'e1000000-0000-4000-8000-000000000001'
      ORDER BY
        created_at DESC
      LIMIT
        1
    ),
    'application_approved',
    'the applicant receives an approval notification'
  );


SELECT
  IS (
    (
      SELECT
        read_at
      FROM
        public.notifications
      WHERE
        recipient_id = 'e1000000-0000-4000-8000-000000000001'
      ORDER BY
        created_at DESC
      LIMIT
        1
    ),
    NULL,
    'a fresh notification is unread'
  );


-- 另一名成员看不到申请人的通知
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.notifications
    ),
    0,
    'other members cannot see someone else''s notifications'
  );


-- 收件人本人可以标记已读
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


UPDATE public.notifications
SET
  read_at = now()
WHERE
  recipient_id = 'e1000000-0000-4000-8000-000000000001';


SELECT
  ok (
    (
      SELECT
        read_at IS NOT NULL
      FROM
        public.notifications
      WHERE
        recipient_id = 'e1000000-0000-4000-8000-000000000001'
      ORDER BY
        created_at DESC
      LIMIT
        1
    ),
    'the recipient can mark their own notification as read'
  );


ROLLBACK;