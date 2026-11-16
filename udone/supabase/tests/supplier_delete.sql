-- A5 供应商删除：策略与外键保护。
--
-- 断的是三件事：有 supplier.write 才能删；没有的人删不动（0 行，不报错）；
-- 被应付行引用时以 23503 拒绝 —— 接口层据此回 409 OBJECT_REFERENCED。
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
    'f1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'supplier-operator@example.test',
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
    'supplier-finance@example.test',
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
    'supplier org',
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


INSERT INTO
  public.suppliers (id, organization_id, name, type, settlement)
VALUES
  (
    'f3000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    '可删供应商',
    'transport',
    'per_trip'
  ),
  (
    'f3000000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000001',
    '被引用供应商',
    'transport',
    'per_trip'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'f4000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    '供应商测试客户',
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


-- 走真实入口建单，省得猜 orders 的必填列。
SELECT
  public.create_order_with_items (
    'f4000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":2000}]'::jsonb,
    '[]'::jsonb,
    '供应商测试订单',
    '2026-12-20',
    '2026-12-21',
    1,
    0
  );


RESET ROLE;


-- 造一条应付，把「被引用供应商」挂上去。
INSERT INTO
  public.order_payables (organization_id, order_id, supplier_id, name, amount)
VALUES
  (
    'f2000000-0000-4000-8000-000000000001',
    (
      SELECT
        id
      FROM
        public.orders
      WHERE
        route_name = '供应商测试订单'
    ),
    'f3000000-0000-4000-8000-000000000002',
    '地接费用',
    800
  );


SET
  local role authenticated;


-- 财务只有 supplier.read：删除被策略挡下，0 行，而不是报错。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


WITH
  deleted AS (
    DELETE FROM public.suppliers
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
    'a reader without supplier.write cannot delete a supplier'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.suppliers
      WHERE
        id = 'f3000000-0000-4000-8000-000000000001'
    ),
    1,
    'the supplier survived the blocked delete'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


WITH
  deleted AS (
    DELETE FROM public.suppliers
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
    'an operator with supplier.write deletes an unreferenced supplier'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.suppliers
      WHERE
        id = 'f3000000-0000-4000-8000-000000000001'
    ),
    0,
    'the unreferenced supplier is really gone'
  );


SELECT
  throws_ok (
    $$DELETE FROM public.suppliers WHERE id = 'f3000000-0000-4000-8000-000000000002'$$,
    '23503',
    NULL,
    'a supplier referenced by a payable cannot be deleted'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.suppliers
      WHERE
        organization_id = 'f2000000-0000-4000-8000-000000000001'
    ),
    1,
    'only the referenced supplier is left'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
