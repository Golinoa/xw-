-- C5 游客名单：去重键、可见性继承、以及「整批导入不产生部分写入」。
--
-- 本文件断的不是「CRUD 能跑」，而是四件容易做错的事：
--   1. 去重真的建在**规范化**证件号上（空格/连字符/小写不会绕过唯一索引）；
--   2. 证件号为空的行**不参与**去重（两个人没登记号码，不该被合并成一个人）；
--   3. 名单的可见性继承订单：别人的单子连名单都读不到，`own` 数据范围也生效；
--   4. 导入函数在批内重复时**整批回滚**——覆盖模式已经删掉的老数据必须回来。
BEGIN;


SELECT
  plan (17);


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
    'a1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'tourist-operator@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'other-operator@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'a1000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'tourist-finance@example.test',
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
    'a2000000-0000-4000-8000-000000000001',
    'tourist org',
    'a1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    'operator'
  ),
  (
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000003',
    'finance'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'a4000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    '游客测试客户甲',
    '13900000071',
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    'a4000000-0000-4000-8000-000000000002',
    'a2000000-0000-4000-8000-000000000001',
    '游客测试客户乙',
    '13900000072',
    'a1000000-0000-4000-8000-000000000002'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"a2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


-- 两个计调员各自开一张单：`own` 数据范围让我们能验「别人的单子的名单读不到」。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'a4000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":3000}]'::jsonb,
    '[]'::jsonb,
    '游客测试线路',
    '2027-03-01',
    '2027-03-05',
    1,
    0
  );


-- 订单 id 存进会话变量：后面要以「另一个计调员」的身份拿着这个 id 去导入，
-- 而他根本读不到这张单子 —— 这正是要验的那条路。
SELECT
  set_config(
    'tourist_test.order1',
    (
      SELECT
        id::text
      FROM
        public.orders
      WHERE
        customer_id = 'a4000000-0000-4000-8000-000000000001'
    ),
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'a4000000-0000-4000-8000-000000000002',
    'booking',
    '[{"name":"团款","amount":2000}]'::jsonb,
    '[]'::jsonb,
    '别人家的线路',
    '2027-04-01',
    '2027-04-03',
    1,
    0
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


-- 1. 计调员给自己的单子加游客：`created_by` 由数据库默认值填成本人（策略要求它相等）。
SELECT
  lives_ok (
    $sql$
    INSERT INTO public.tourists (organization_id, order_id, name, phone, document_type, document_number, person_type, age, gender)
    VALUES (
      'a2000000-0000-4000-8000-000000000001',
      (SELECT id FROM public.orders WHERE customer_id = 'a4000000-0000-4000-8000-000000000001'),
      '张一', '13800000101', 'id_card', '110101-19900101-1234 ', 'adult', 36, 'male'
    )
    $sql$,
    'an operator with order.write adds a tourist to their own order'
  );


-- 2. 规范化是生成列的事：空格、连字符都在库里被去掉，大写统一。
SELECT
  IS (
    (
      SELECT
        normalized_document_number
      FROM
        public.tourists
      WHERE
        name = '张一'
    ),
    '110101199001011234',
    'the generated column normalizes spaces and hyphens'
  );


-- 3. 同一张单、同证件、不同写法 → 撞唯一索引。它是 409 的来源。
SELECT
  throws_ok (
    $sql$
    INSERT INTO public.tourists (organization_id, order_id, name, document_type, document_number)
    VALUES (
      'a2000000-0000-4000-8000-000000000001',
      (SELECT id FROM public.orders WHERE customer_id = 'a4000000-0000-4000-8000-000000000001'),
      '张一重复', 'id_card', '110101199001011234'
    )
    $sql$,
    '23505',
    NULL,
    'a normalized duplicate document number is rejected'
  );


-- 4. 没有证件号的两个人：不去重，两行都进得去（空号码不自动合并）。
SELECT
  lives_ok (
    $sql$
    INSERT INTO public.tourists (organization_id, order_id, name, person_type)
    VALUES
      ('a2000000-0000-4000-8000-000000000001', (SELECT id FROM public.orders WHERE customer_id = 'a4000000-0000-4000-8000-000000000001'), '无证甲', 'adult'),
      ('a2000000-0000-4000-8000-000000000001', (SELECT id FROM public.orders WHERE customer_id = 'a4000000-0000-4000-8000-000000000001'), '无证乙', 'child')
    $sql$,
    'tourists without a document number are never merged'
  );


-- 5. 有号码没类型：去重键少一维，CHECK 直接拒绝，不留「护照与身份证同号」的口子。
SELECT
  throws_ok (
    $sql$
    INSERT INTO public.tourists (organization_id, order_id, name, document_number)
    VALUES (
      'a2000000-0000-4000-8000-000000000001',
      (SELECT id FROM public.orders WHERE customer_id = 'a4000000-0000-4000-8000-000000000001'),
      '只填号码', 'E12345678'
    )
    $sql$,
    '23514',
    NULL,
    'a document number without a document type is rejected'
  );


-- 6. 财务没有 order.write：名单写不进去。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $sql$
    INSERT INTO public.tourists (organization_id, order_id, name, person_type)
    VALUES (
      'a2000000-0000-4000-8000-000000000001',
      (SELECT id FROM public.orders WHERE customer_id = 'a4000000-0000-4000-8000-000000000001'),
      '财务想加的游客', 'adult'
    )
    $sql$,
    '42501',
    NULL,
    'a finance member cannot write the roster'
  );


-- 7. 财务能读（order.read 通过 orders 策略继承），但删不掉。
SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.tourists
    ),
    3,
    'a finance member reads the roster through the order visibility'
  );


WITH
  deleted AS (
    DELETE FROM public.tourists
    WHERE
      name = '张一'
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
    'a finance member cannot delete a tourist'
  );


-- 8. 另一个计调员的 own 范围：看不见别人的单子，连名单一起看不见。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.tourists
    ),
    0,
    'another operator cannot see tourists of an order outside their scope'
  );


-- 9. 别人的单子连导入都进不去：订单读不到就等于不存在（P0002）。
SELECT
  throws_ok (
    $sql$
    SELECT * FROM public.import_tourists (
      current_setting('tourist_test.order1')::uuid,
      'append',
      '[{"name":"越权游客","person_type":"adult"}]'::jsonb
    )
    $sql$,
    'P0002',
    NULL,
    'importing into an invisible order reports not found'
  );


-- 10. 追加模式：2 行全进，返回 inserted=2 / deleted=0。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        inserted_count
      FROM
        public.import_tourists (
          (
            SELECT
              id
            FROM
              public.orders
            WHERE
              customer_id = 'a4000000-0000-4000-8000-000000000001'
          ),
          'append',
          '[{"name":"李二","document_type":"passport","document_number":"e12345678","person_type":"adult","age":30,"gender":"female"},
            {"name":"王三","person_type":"child","age":8,"gender":"male"}]'::jsonb
        )
    ),
    2,
    'append mode inserts every parsed row'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.tourists
    ),
    5,
    'the roster holds the manual and imported rows together'
  );


-- 11. 覆盖模式：先删 5 行，再插 1 行。返回值同时给出两边。
SELECT
  IS (
    (
      SELECT
        deleted_count
      FROM
        public.import_tourists (
          (
            SELECT
              id
            FROM
              public.orders
            WHERE
              customer_id = 'a4000000-0000-4000-8000-000000000001'
          ),
          'replace',
          '[{"name":"覆盖后唯一游客","document_type":"taiwan_permit","document_number":"T 99887766","person_type":"adult"}]'::jsonb
        )
    ),
    5,
    'replace mode removes the previous roster'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.tourists
    ),
    1,
    'replace mode leaves exactly the imported rows'
  );


-- 12. 批内重复：整批回滚。覆盖模式已经删掉的 1 行必须回来 —— 否则用户会
--     在「导入失败」之后发现名单被清空了，而那是不可逆的数据丢失。
SELECT
  throws_ok (
    $sql$
    SELECT * FROM public.import_tourists (
      (SELECT id FROM public.orders WHERE customer_id = 'a4000000-0000-4000-8000-000000000001'),
      'replace',
      '[{"name":"重复甲","document_type":"id_card","document_number":"110101199001011234","person_type":"adult"},
        {"name":"重复乙","document_type":"id_card","document_number":"110101-19900101-1234","person_type":"adult"}]'::jsonb
    )
    $sql$,
    '23505',
    NULL,
    'a duplicated document inside one batch aborts the whole import'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.tourists
    ),
    1,
    'the failed replace leaves the previous roster untouched'
  );


-- 13. 计调员删自己的游客：命中 1 行。
WITH
  deleted AS (
    DELETE FROM public.tourists
    WHERE
      name = '覆盖后唯一游客'
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
    'an operator deletes a tourist from their own order'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;