-- 客户域 RLS 与租户一致性。
--
-- 这些断言只在真实 PostgreSQL 上才有意义：策略是 SQL 表达式，
-- 「读代码觉得对」和「策略真的挡住了」是两件事。
BEGIN;


SELECT
  plan (15);


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
    'customer-admin@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'c1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'customer-operator@example.test',
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
    'customer-finance@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'c1000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'customer-outsider@example.test',
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
    'customer org x',
    'c1000000-0000-4000-8000-000000000001'
  ),
  (
    'c2000000-0000-4000-8000-000000000002',
    'customer org y',
    'c1000000-0000-4000-8000-000000000004'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'admin'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000002',
    'operator'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000003',
    'finance'
  ),
  (
    'c2000000-0000-4000-8000-000000000002',
    'c1000000-0000-4000-8000-000000000004',
    'admin'
  );


-- 夹具以超级用户写入，绕过 RLS：这里要测的是「读的时候挡不挡得住」，
-- 不是「写不写得进去」。
INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'c3000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    '管理员创建的客户',
    '13800000001',
    'c1000000-0000-4000-8000-000000000001'
  ),
  (
    'c3000000-0000-4000-8000-000000000002',
    'c2000000-0000-4000-8000-000000000001',
    '操作员创建的客户',
    '13800000002',
    'c1000000-0000-4000-8000-000000000002'
  ),
  (
    'c3000000-0000-4000-8000-000000000004',
    'c2000000-0000-4000-8000-000000000002',
    '另一个组织的客户',
    '13800000004',
    'c1000000-0000-4000-8000-000000000004'
  );


INSERT INTO
  public.customers (
    id,
    organization_id,
    name,
    phone,
    created_by,
    deleted_at,
    deleted_by
  )
VALUES
  (
    'c3000000-0000-4000-8000-000000000003',
    'c2000000-0000-4000-8000-000000000001',
    '已软删除的客户',
    '13800000003',
    'c1000000-0000-4000-8000-000000000001',
    now(),
    'c1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.customer_tags (id, organization_id, name, color)
VALUES
  (
    'c4000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    '重点客户',
    '#1677ff'
  ),
  (
    'c4000000-0000-4000-8000-000000000002',
    'c2000000-0000-4000-8000-000000000002',
    '另一组织的标签',
    '#faad14'
  );


INSERT INTO
  public.customer_tag_links (customer_id, tag_id, organization_id)
VALUES
  (
    'c3000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"c2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customers
    ),
    2,
    'admin reads every live customer of the organization'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customers
      WHERE
        id = 'c3000000-0000-4000-8000-000000000004'
    ),
    0,
    'admin cannot read a customer of another organization'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customer_tag_links
    ),
    1,
    'tag links follow the same organization boundary'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customers
      WHERE
        deleted_at IS NOT NULL
    ),
    0,
    'soft deleted customers stay invisible even though the row still exists'
  );


-- 换成操作员（数据范围 own）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    public.current_data_scope (),
    'own',
    'operator scope is own'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customers
    ),
    1,
    'operator reads only the customer they created'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customers
      WHERE
        id = 'c3000000-0000-4000-8000-000000000001'
    ),
    0,
    'operator cannot read a customer created by someone else'
  );


-- RLS 拦更新不会报错，只是把行筛掉；所以语句先执行，再由看得见该行的人确认没改到。
UPDATE public.customers
SET
  name = '越权改名'
WHERE
  id = 'c3000000-0000-4000-8000-000000000001';


UPDATE public.customers
SET
  name = '操作员改自己的客户'
WHERE
  id = 'c3000000-0000-4000-8000-000000000002';


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customers
      WHERE
        name = '操作员改自己的客户'
    ),
    1,
    'operator can update a customer they created'
  );


-- 换成财务（只读，数据范围 all）。
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
        count(*)::int
      FROM
        public.customers
    ),
    2,
    'finance role reads the whole organization but cannot write'
  );


SELECT
  throws_like (
    $sql$
    INSERT INTO public.customers (organization_id, name, created_by)
    VALUES ('c2000000-0000-4000-8000-000000000001', '财务越权写入', 'c1000000-0000-4000-8000-000000000003')
    $sql$,
    '%row-level security%',
    'finance role cannot insert a customer'
  );


-- 换成另一个组织的管理员，确认租户边界是组织而不是角色。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000004","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"c2000000-0000-4000-8000-000000000002"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customers
      WHERE
        organization_id = 'c2000000-0000-4000-8000-000000000001'
    ),
    0,
    'an admin of another organization sees none of these customers'
  );


-- 回到组织 X 的管理员，测写入路径。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"c2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


-- 回到管理员视角确认：操作员那次越权 UPDATE 实际上什么都没改。
SELECT
  IS (
    (
      SELECT
        name
      FROM
        public.customers
      WHERE
        id = 'c3000000-0000-4000-8000-000000000001'
    ),
    '管理员创建的客户',
    'operator cannot update a customer outside their own data scope'
  );


SELECT
  throws_like (
    $sql$
    INSERT INTO public.customer_tag_links (customer_id, tag_id, organization_id)
    VALUES ('c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001')
    $sql$,
    '%foreign key constraint%',
    'a tag from another organization cannot be linked across tenants'
  );


-- customers 的 INSERT 是列级授权，显式写 id 会撞「permission denied for table」，
-- 所以这里不指定主键，让它走 gen_random_uuid() 默认值。
SELECT
  lives_ok (
    $sql$
    INSERT INTO public.customers (organization_id, name, phone, created_by)
    VALUES ('c2000000-0000-4000-8000-000000000001', '新客户', '138-0000-0009', 'c1000000-0000-4000-8000-000000000001')
    $sql$,
    'admin can create a customer'
  );


SELECT
  IS (
    (
      SELECT
        phone_normalized
      FROM
        public.customers
      WHERE
        name = '新客户'
    ),
    '13800000009',
    'phone_normalized is generated from the raw phone value'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;