-- B2（第一步）：恢复权限与「读已删除」策略。
--
-- 断言的顺序刻意这样排：先证明「没有权限看不见」，再证明「有权限看得见」，
-- 最后证明「恢复之后所有人都看得见」。只断最后一层的话，策略写宽了也测不出来。
BEGIN;


SELECT
  plan (12);


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
    'restore-operator@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'c1000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'restore-admin@example.test',
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
    'restore org',
    'c1000000-0000-4000-8000-000000000003'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000003',
    'admin'
  );


-- 已删除的客户：直接以超级用户写入并带上 deleted_at，
-- 避免依赖「删除动作」本身（它不是本卡要测的东西）。
INSERT INTO
  public.customers (
    id,
    organization_id,
    name,
    phone,
    created_by,
    deleted_at
  )
VALUES
  (
    'c3000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    '已删除客户',
    '13900000061',
    'c1000000-0000-4000-8000-000000000001',
    now()
  ),
  (
    'c3000000-0000-4000-8000-000000000002',
    'c2000000-0000-4000-8000-000000000001',
    '在册客户',
    '13900000062',
    'c1000000-0000-4000-8000-000000000001',
    NULL
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"c2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


-- 顺手造一张订单，稍后同样软删。走真实入口，省得猜 orders 的必填列。
-- 用「在册客户」：RPC 会拒绝已删除的客户，这是另一条已有的守卫。
SELECT
  public.create_order_with_items (
    'c3000000-0000-4000-8000-000000000002',
    'booking',
    '[{"name":"团款","amount":1000}]'::jsonb,
    '[]'::jsonb,
    '回收站测试订单',
    '2026-12-20',
    '2026-12-21',
    1,
    0
  );


RESET ROLE;


UPDATE public.orders
SET
  deleted_at = now()
WHERE
  route_name = '回收站测试订单';


-- ---------------------------------------------------------------- 客户侧
SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.customers
      WHERE
        id = 'c3000000-0000-4000-8000-000000000001'
    ),
    0,
    'an operator without customer.restore cannot read a deleted customer'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.customers
      WHERE
        id = 'c3000000-0000-4000-8000-000000000001'
    ),
    1,
    'an admin with customer.restore can read the deleted customer'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $$SELECT public.restore_customer ('c3000000-0000-4000-8000-000000000001')$$,
    '42501',
    'customer.restore is required',
    'an operator cannot restore without the permission'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    public.restore_customer ('c3000000-0000-4000-8000-000000000001'),
    'c3000000-0000-4000-8000-000000000001'::uuid,
    'the admin restores the customer and gets its id back'
  );


SELECT
  IS (
    (
      SELECT
        deleted_at
      FROM
        public.customers
      WHERE
        id = 'c3000000-0000-4000-8000-000000000001'
    ),
    NULL::timestamptz,
    'restoring clears deleted_at and touches nothing else'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.customers
      WHERE
        id = 'c3000000-0000-4000-8000-000000000001'
    ),
    1,
    'the restored customer is visible to everyone again'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    public.restore_customer ('c3000000-0000-4000-8000-000000000001'),
    NULL::uuid,
    'restoring an already visible customer is a no-op, not an error'
  );


-- ---------------------------------------------------------------- 订单侧
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.orders
      WHERE
        route_name = '回收站测试订单'
    ),
    0,
    'an operator without order.restore cannot read a deleted order'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.orders
      WHERE
        route_name = '回收站测试订单'
    ),
    1,
    'an admin with order.restore can read the deleted order'
  );


SELECT
  IS (
    public.restore_order (
      (
        SELECT
          id
        FROM
          public.orders
        WHERE
          route_name = '回收站测试订单'
      )
    ) IS NOT NULL,
    TRUE,
    'the admin restores the order'
  );


SELECT
  IS (
    (
      SELECT
        deleted_at
      FROM
        public.orders
      WHERE
        route_name = '回收站测试订单'
    ),
    NULL::timestamptz,
    'restoring an order clears deleted_at'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.orders
      WHERE
        route_name = '回收站测试订单'
    ),
    1,
    'the restored order is visible to everyone again'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
