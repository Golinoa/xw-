-- C2 客户来源维护：删除策略与外键保护。
--
-- 两条外键（客户引用、父子关系）都是 RESTRICT，删除策略只是「让删除能被执行」。
-- 这里要断的是：有写权限的人真的能删；没有的人删不动（行数为 0，不报错）；
-- 被引用的删不掉，且以 23503 冲突回来 —— 接口层据此映射 409。
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
    'e1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'source-operator@example.test',
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
    'source-finance@example.test',
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
    'source org',
    'e1000000-0000-4000-8000-000000000001'
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
  );


-- 三个来源：可自由删除的、被客户引用的、下面挂着子来源的根。
INSERT INTO
  public.customer_sources (id, organization_id, name, sort_order)
VALUES
  (
    'e3000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    '可删来源',
    10
  ),
  (
    'e3000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000001',
    '被引用来源',
    20
  ),
  (
    'e3000000-0000-4000-8000-000000000003',
    'e2000000-0000-4000-8000-000000000001',
    '有子的根',
    30
  ),
  (
    'e3000000-0000-4000-8000-000000000004',
    'e2000000-0000-4000-8000-000000000001',
    '子来源',
    40
  );


UPDATE public.customer_sources
SET
  parent_id = 'e3000000-0000-4000-8000-000000000003'
WHERE
  id = 'e3000000-0000-4000-8000-000000000004';


INSERT INTO
  public.customers (id, organization_id, name, phone, source_id, created_by)
VALUES
  (
    'e4000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    '来源测试客户',
    '13900000081',
    'e3000000-0000-4000-8000-000000000002',
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


-- 财务只有 customer.read：删除请求被策略挡下，行数为 0，但不报错。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


WITH
  deleted AS (
    DELETE FROM public.customer_sources
    WHERE
      id = 'e3000000-0000-4000-8000-000000000001'
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
    'a reader without customer.write cannot delete a source'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.customer_sources
      WHERE
        id = 'e3000000-0000-4000-8000-000000000001'
    ),
    1,
    'the source survived the blocked delete'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


WITH
  deleted AS (
    DELETE FROM public.customer_sources
    WHERE
      id = 'e3000000-0000-4000-8000-000000000001'
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
    'an operator with customer.write deletes an unused source'
  );


SELECT
  throws_ok (
    $$DELETE FROM public.customer_sources WHERE id = 'e3000000-0000-4000-8000-000000000002'$$,
    '23503',
    NULL,
    'a source referenced by a customer cannot be deleted'
  );


SELECT
  throws_ok (
    $$DELETE FROM public.customer_sources WHERE id = 'e3000000-0000-4000-8000-000000000003'$$,
    '23503',
    NULL,
    'a root source that still has children cannot be deleted'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.customer_sources
      WHERE
        organization_id = 'e2000000-0000-4000-8000-000000000001'
    ),
    3,
    'the referenced and the parent sources are still there'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
