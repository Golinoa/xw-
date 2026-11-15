-- C3 标签管理补全：改名策略、删除授权、删除保护。
--
-- 要断的四件事：
--   1. 有 customer.write 的人能改名；没有的人改名影响 0 行（策略挡住，不报错）。
--   2. 没有 customer.write 的人删除影响 0 行 —— 这一条同时证明表级 GRANT DELETE 存在，
--      否则拿到的是 `permission denied` 而不是 0 行。
--   3. 被客户引用的标签删不掉，以 23503 回来（外键从 CASCADE 收紧成 RESTRICT）。
--   4. 解除引用后可以删除，且删除标签不会连带删掉客户的其它关联。
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
    'f1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'tag-operator@example.test',
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
    'tag-finance@example.test',
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
    'tag org',
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


-- 两个标签：一个被客户引用，一个无人引用。
INSERT INTO
  public.customer_tags (id, organization_id, name, color)
VALUES
  (
    'f3000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    '被引用标签',
    '#1b2a4a'
  ),
  (
    'f3000000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000001',
    '空标签',
    NULL
  );


INSERT INTO
  public.customers (id, organization_id, name, created_by)
VALUES
  (
    'f4000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    '标签测试客户',
    'f1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.customer_tag_links (customer_id, tag_id, organization_id)
VALUES
  (
    'f4000000-0000-4000-8000-000000000001',
    'f3000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"f2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


-- 财务只有 customer.read：改名被策略挡下，影响 0 行。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


WITH
  renamed AS (
    UPDATE public.customer_tags
    SET
      name = '财务改名'
    WHERE
      id = 'f3000000-0000-4000-8000-000000000001'
    RETURNING
      id
  )
SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        renamed
    ),
    0,
    'a reader without customer.write cannot rename a tag'
  );


SELECT
  IS (
    (
      SELECT
        name
      FROM
        public.customer_tags
      WHERE
        id = 'f3000000-0000-4000-8000-000000000001'
    ),
    '被引用标签',
    'the tag name survived the blocked rename'
  );


WITH
  deleted AS (
    DELETE FROM public.customer_tags
    WHERE
      id = 'f3000000-0000-4000-8000-000000000002'
    RETURNING
      id
  )
SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        deleted
    ),
    0,
    'a reader without customer.write cannot delete a tag'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


WITH
  renamed AS (
    UPDATE public.customer_tags
    SET
      name = 'VIP 客户',
      color = '#c0392b'
    WHERE
      id = 'f3000000-0000-4000-8000-000000000001'
    RETURNING
      id,
      name,
      color
  )
SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        renamed
      WHERE
        name = 'VIP 客户'
        AND color = '#c0392b'
    ),
    1,
    'an operator with customer.write renames a tag'
  );


SELECT
  throws_ok (
    $$DELETE FROM public.customer_tags WHERE id = 'f3000000-0000-4000-8000-000000000001'$$,
    '23503',
    NULL,
    'a tag still linked to a customer cannot be deleted'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.customer_tag_links
      WHERE
        tag_id = 'f3000000-0000-4000-8000-000000000001'
    ),
    1,
    'the blocked delete left the link untouched instead of cascading'
  );


DELETE FROM public.customer_tag_links
WHERE
  tag_id = 'f3000000-0000-4000-8000-000000000001';


WITH
  deleted AS (
    DELETE FROM public.customer_tags
    WHERE
      id = 'f3000000-0000-4000-8000-000000000001'
    RETURNING
      id
  )
SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        deleted
    ),
    1,
    'the tag is deletable once nothing links to it'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;