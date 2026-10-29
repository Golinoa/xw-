-- 明细行写入策略的父订单状态守卫（R-ORDER 状态机 + R-FIN-01）。
--
-- 背景：应收/应付明细的写策略原先只校验「同组织 + order.write + 父订单可见」，
-- 没有校验父订单状态。走 API 时 update_order_with_items 会返回
-- ORDER_STATE_CONFLICT，但直连 PostgREST 拿用户 JWT 就能给已锁团（completed）
-- 或已取消（cancelled）的订单增删改金额行——等于利润可以被事后篡改。
--
-- 这里用真角色验证三件事：
--   1. booking/active 下直连写明细是允许的（证明下面的拒绝不是因为权限不够）
--   2. completed / cancelled 下 INSERT 被策略拒绝，UPDATE/DELETE 影响 0 行
--   3. 函数路径在 completed 上仍返回 ORDER_STATE_CONFLICT 而不是抛 42501 变 500
--
-- 第 1 条是这个文件的关键：没有它，后面每一条「被拒绝」都可能只是
-- GRANT 缺失造成的假阳性，测试看起来全绿却什么都没守住。
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
    'b1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'line-guard@example.test',
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
    'line guard org',
    'b1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'b3000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001',
    '状态守卫客户',
    '13900000031',
    'b1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.suppliers (
    id,
    organization_id,
    name,
    type,
    settlement,
    is_active
  )
VALUES
  (
    'b4000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001',
    '状态守卫地接',
    'transport',
    'per_trip',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"b2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


-- 订单 A：走完 confirm + lock，用来测 completed；之后 unlock 回 active 再测一次放行。
SELECT
  public.create_order_with_items (
    'b3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":7500}]'::jsonb,
    '[{"name":"地接","amount":4800,"supplierId":"b4000000-0000-4000-8000-000000000001"}]'::jsonb,
    '状态守卫A',
    '2026-12-01',
    '2026-12-08',
    2,
    1
  );


SELECT
  set_config(
    'test.order_a',
    (
      SELECT
        id::text
      FROM
        public.orders
      WHERE
        route_name = '状态守卫A'
    ),
    TRUE
  );


-- 订单 B：直接取消，用来测 cancelled。
SELECT
  public.create_order_with_items (
    'b3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":3000}]'::jsonb,
    '[]'::jsonb,
    '状态守卫B',
    '2026-12-10',
    '2026-12-12',
    2,
    0
  );


SELECT
  set_config(
    'test.order_b',
    (
      SELECT
        id::text
      FROM
        public.orders
      WHERE
        route_name = '状态守卫B'
    ),
    TRUE
  );


-- 基线：booking 状态下，直连插入一条应收行必须成功。
-- 这条同时证明 authenticated 确实持有 insert 列权限，后面被拒是策略而不是授权。
SELECT
  lives_ok (
    $sql$
    INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
    VALUES (
      'b2000000-0000-4000-8000-000000000001',
      current_setting('test.order_a')::uuid,
      'booking 可写',
      100
    )
    $sql$,
    'a receivable line can be inserted while the order is still booking'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
      WHERE
        name = 'booking 可写'
    ),
    1,
    'the inserted line is really there'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.transition_order_status (
          current_setting('test.order_a')::uuid,
          'confirm',
          1
        )
    ),
    NULL::text,
    'order A can be confirmed'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.transition_order_status (current_setting('test.order_a')::uuid, 'lock', 2)
    ),
    NULL::text,
    'order A can be locked into completed'
  );


-- completed：插入被 WITH CHECK 拒绝，会直接抛 42501。
SELECT
  throws_like (
    $sql$
    INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
    VALUES (
      'b2000000-0000-4000-8000-000000000001',
      current_setting('test.order_a')::uuid,
      'completed 不可写',
      200
    )
    $sql$,
    '%row-level security%',
    'a completed order cannot receive a new receivable line'
  );


-- completed：UPDATE 的 USING 不成立时 PostgreSQL 静默影响 0 行，不报错，
-- 所以断言的是「值没变」而不是「抛异常」。
UPDATE public.order_receivables
SET
  name = '被篡改'
WHERE
  order_id = current_setting('test.order_a')::uuid
  AND name = '团款';


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.order_a')::uuid
        AND name = '被篡改'
    ),
    0,
    'a completed order line cannot be renamed'
  );


DELETE FROM public.order_receivables
WHERE
  order_id = current_setting('test.order_a')::uuid
  AND name = 'booking 可写';


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.order_a')::uuid
        AND name = 'booking 可写'
    ),
    1,
    'a completed order line cannot be deleted'
  );


-- 函数路径必须仍然给出可映射的错误码。如果这里抛 42501，
-- API 会把它当成 500 而不是可映射的 409，前端就没有动作可提示。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          current_setting('test.order_a')::uuid,
          3,
          'b3000000-0000-4000-8000-000000000001',
          'booking',
          '[{"name":"团款","amount":7500}]'::jsonb,
          '[{"name":"地接","amount":4800,"supplierId":"b4000000-0000-4000-8000-000000000001"}]'::jsonb,
          '改个名字',
          '2026-12-01',
          '2026-12-08',
          2,
          1
        )
    ),
    'ORDER_STATE_CONFLICT',
    'the function reports a conflict instead of leaking a 42501'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.transition_order_status (
          current_setting('test.order_a')::uuid,
          'unlock',
          3
        )
    ),
    NULL::text,
    'order A can be unlocked back to active'
  );


-- 解锁回 active 之后必须又能写：证明被挡的是状态，不是把整条路径焊死。
SELECT
  lives_ok (
    $sql$
    INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
    VALUES (
      'b2000000-0000-4000-8000-000000000001',
      current_setting('test.order_a')::uuid,
      'unlock 后可写',
      300
    )
    $sql$,
    'the same order accepts lines again after unlock'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.transition_order_status (
          current_setting('test.order_b')::uuid,
          'cancel',
          1,
          '客户放弃行程'
        )
    ),
    NULL::text,
    'order B can be cancelled'
  );


SELECT
  throws_like (
    $sql$
    INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
    VALUES (
      'b2000000-0000-4000-8000-000000000001',
      current_setting('test.order_b')::uuid,
      'cancelled 不可写',
      400
    )
    $sql$,
    '%row-level security%',
    'a cancelled order cannot receive a new receivable line'
  );


SELECT
  *
FROM
  finish ();