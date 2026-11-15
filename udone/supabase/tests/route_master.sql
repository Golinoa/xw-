-- C4 线路主数据：RLS、名称唯一、以及「历史订单不随主数据漂移」。
--
-- 本文件要断的不是「CRUD 能跑」，而是三件容易做错的事：
--   1. 写权限真的落到 route.write 上（财务只读：能选线路、不能维护线路）；
--   2. 同组织内线路名唯一，跨组织同名互不影响且互相看不见；
--   3. **改名 / 删线路之后，历史订单里的 `route_name` 一个字都不变** ——
--      这是 R-ROUTE-01 与 R-FIN-01 的共同要求，也是本卡不加 `route_id` 外键的前提。
BEGIN;


SELECT
  plan (10);


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
    'f1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'route-operator@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'f1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'route-finance@example.test',
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
    'f2000000-0000-4000-8000-000000000001',
    'route org',
    'f1000000-0000-4000-8000-000000000001'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'other route org',
    'f1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'f2000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'f2000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000002',
    'finance'
  );


-- 另一个组织的线路：用来证明跨组织既读不到、也不受同名约束影响。
INSERT INTO
  public.routes (id, organization_id, name, days, created_by)
VALUES
  (
    'f3000000-0000-4000-8000-0000000000ff',
    'f2000000-0000-4000-8000-000000000002',
    '别家的线路',
    5,
    'f1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'f4000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    '线路测试客户',
    '13900000091',
    'f1000000-0000-4000-8000-000000000001'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"f2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


-- 1. 计调员有 route.write：建线路成功，且 created_by 由数据库填成本人。
SELECT
  lives_ok (
    $sql$
    INSERT INTO public.routes (id, organization_id, name, route_type, region, days)
    VALUES (
      'f3000000-0000-4000-8000-000000000001',
      'f2000000-0000-4000-8000-000000000001',
      '云南六日游', '境内跟团', '云南', 6
    )
    $sql$,
    'an operator with route.write creates a route'
  );


-- 2. 财务只有 route.read：插入被 RLS 挡下（42501，不是静默 0 行）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $sql$
    INSERT INTO public.routes (id, organization_id, name)
    VALUES (
      'f3000000-0000-4000-8000-000000000002',
      'f2000000-0000-4000-8000-000000000001',
      '财务想建的线路'
    )
    $sql$,
    '42501',
    NULL,
    'a finance member cannot create a route'
  );


-- 3. 同组织重名：撞唯一索引（23505），接口层据此返回 409。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $sql$
    INSERT INTO public.routes (id, organization_id, name)
    VALUES (
      'f3000000-0000-4000-8000-000000000003',
      'f2000000-0000-4000-8000-000000000001',
      '云南六日游'
    )
    $sql$,
    '23505',
    NULL,
    'a duplicate route name in the same organization is rejected'
  );


-- 4. 跨组织的线路读不到（RLS 按 current_organization_id 过滤）。
SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.routes
      WHERE
        name = '别家的线路'
    ),
    0,
    'routes of another organization are invisible'
  );


-- 5. 用刚建的线路开一张订单：订单只存名称，不存线路 id。
SELECT
  lives_ok (
    $sql$
    SELECT public.create_order_with_items (
      'f4000000-0000-4000-8000-000000000001',
      'booking',
      '[{"name":"团款","amount":7600}]'::jsonb,
      '[]'::jsonb,
      '云南六日游',
      '2026-12-01',
      '2026-12-07',
      2,
      0
    )
    $sql$,
    'an order can snapshot the route name'
  );


-- 6. 改名：UPDATE 策略生效（返回 1 行）。
-- 数据修改型 CTE 必须在语句最外层，不能塞进 `IS(子查询)`。
WITH
  updated AS (
    UPDATE public.routes
    SET
      name = '云南七日游',
      days = 7
    WHERE
      id = 'f3000000-0000-4000-8000-000000000001'
    RETURNING
      id
  )
SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        updated
    ),
    1,
    'renaming a route updates exactly one row'
  );


-- 7. 关键断言：改名之后，历史订单里的线路名仍是下单当时那个。
SELECT
  IS (
    (
      SELECT
        route_name
      FROM
        public.orders
      WHERE
        customer_id = 'f4000000-0000-4000-8000-000000000001'
    ),
    '云南六日游',
    'the historical order keeps the name captured at creation time'
  );


-- 8. 财务删线路：策略挡下，0 行（不报错，因为 DELETE 的 USING 不匹配即静默过滤）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


WITH
  deleted AS (
    DELETE FROM public.routes
    WHERE
      id = 'f3000000-0000-4000-8000-000000000001'
    RETURNING
      id
  )
SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        deleted
    ),
    0,
    'a finance member cannot delete a route'
  );


-- 9. 计调员删线路：成功。线路没有被任何表外键引用，删除不该被阻断。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


WITH
  deleted AS (
    DELETE FROM public.routes
    WHERE
      id = 'f3000000-0000-4000-8000-000000000001'
    RETURNING
      id
  )
SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        deleted
    ),
    1,
    'an operator with route.write deletes an unused route'
  );


-- 10. 线路删掉之后订单还在，名称快照也还在 —— 主数据消失不等于历史丢失。
SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.orders
      WHERE
        route_name = '云南六日游'
    ),
    1,
    'the order survives the route deletion with its snapshot'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
