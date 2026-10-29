-- 订单编辑：金额行按 id 增量合并。
--
-- 这里守的是一条会造成资金数据丢失的回归：
-- 旧实现每次都把明细行删光再插入，而插入只带 name/amount，
-- 于是 confirmed_amount / pending_amount 归零——改一次线路名，
-- 客户已确认的 3000 元收款就凭空消失，且没有任何报错。
--
-- 订单号由 create_order_with_items 自己生成，所以真实 id 存进事务级 GUC；
-- 直接写死一个「我以为的」id 会让整组断言在空行上通过或失败，都不可信。
BEGIN;


SELECT
  plan (23);


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
    'line-admin@example.test',
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
    'line org',
    'f1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'f2000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000001',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'f4000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    '线路客户',
    '13900001001',
    'f1000000-0000-4000-8000-000000000001'
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
    'f5000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    '地接社',
    'transport',
    'per_trip',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"f2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  lives_ok (
    $sql$
    SELECT public.create_order_with_items (
      'f4000000-0000-4000-8000-000000000001',
      'booking',
      '[{"name":"团款","amount":7500}]'::jsonb,
      '[{"name":"地接","amount":4800,"supplierId":"f5000000-0000-4000-8000-000000000001"}]'::jsonb,
      '线路A',
      '2026-11-01',
      '2026-11-08',
      2,
      1
    )
    $sql$,
    'admin can create an order to edit'
  );


-- 第二张订单：只为拿到一个「真实存在、但属于别的订单」的行 id。
SELECT
  lives_ok (
    $sql$
    SELECT public.create_order_with_items (
      'f4000000-0000-4000-8000-000000000001',
      'booking',
      '[{"name":"另一单的团款","amount":1000}]'::jsonb,
      '[]'::jsonb,
      '线路X',
      '2026-12-01',
      '2026-12-03',
      1,
      0
    )
    $sql$,
    'a second order provides a foreign line id'
  );


SELECT
  set_config(
    'test.main_order',
    (
      SELECT
        id::text
      FROM
        public.orders
      WHERE
        route_name = '线路A'
    ),
    TRUE
  );


SELECT
  set_config(
    'test.other_order',
    (
      SELECT
        id::text
      FROM
        public.orders
      WHERE
        route_name = '线路X'
    ),
    TRUE
  );


-- 模拟收付款流程已经把 3000 元确认到「团款」这一行上。
-- 只有超级用户可以写 confirmed_amount，客户端没有这个列的权限。
RESET ROLE;


UPDATE public.order_receivables
SET
  confirmed_amount = 3000
WHERE
  order_id = current_setting('test.main_order')::uuid;


SELECT
  IS (
    (
      SELECT
        confirmed_amount
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
    ),
    3000::numeric(14, 2),
    'fixture: 3000 is confirmed on the receivable line'
  );


SET
  local role authenticated;


-- 1. 只改线路名，明细行原样带 id 回传。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.main_order')::uuid,
          requested_version => (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.main_order')::uuid
          ),
          requested_customer_id => 'f4000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => jsonb_build_array(
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_receivables
                WHERE
                  order_id = current_setting('test.main_order')::uuid
                  AND name = '团款'
              ),
              'name',
              '团款',
              'amount',
              7500
            )
          ),
          requested_payables => jsonb_build_array(
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_payables
                WHERE
                  order_id = current_setting('test.main_order')::uuid
                  AND name = '地接'
              ),
              'name',
              '地接',
              'amount',
              4800,
              'supplierId',
              'f5000000-0000-4000-8000-000000000001'
            )
          ),
          requested_route_name => '线路B'
        )
    ),
    NULL,
    'renaming the route succeeds'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
        AND name = '团款'
    ),
    3000::numeric(14, 2),
    'confirmed payment survives an edit that only renames the route'
  );


SELECT
  IS (
    (
      SELECT
        receivable_total
      FROM
        public.orders
      WHERE
        id = current_setting('test.main_order')::uuid
    ),
    7500::numeric(14, 2),
    'order totals are still derived from the line amounts'
  );


SELECT
  IS (
    (
      SELECT
        route_name
      FROM
        public.orders
      WHERE
        id = current_setting('test.main_order')::uuid
    ),
    '线路B',
    'the route name was actually updated'
  );


-- 2. 把金额从 7500 降到 5000（仍高于已确认的 3000）。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.main_order')::uuid,
          requested_version => (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.main_order')::uuid
          ),
          requested_customer_id => 'f4000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => jsonb_build_array(
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_receivables
                WHERE
                  order_id = current_setting('test.main_order')::uuid
                  AND name = '团款'
              ),
              'name',
              '团款',
              'amount',
              5000
            )
          ),
          requested_payables => '[]'::jsonb,
          requested_route_name => '线路B'
        )
    ),
    NULL,
    'amount can be lowered as long as it stays above the confirmed payment'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
        AND name = '团款'
    ),
    3000::numeric(14, 2),
    'the confirmed payment is untouched by an amount change'
  );


SELECT
  IS (
    (
      SELECT
        available_amount
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
        AND name = '团款'
    ),
    2000::numeric(14, 2),
    'available amount is recalculated from the new amount'
  );


-- 3. 金额改到低于已确认的 3000：拒绝，且什么都不写。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.main_order')::uuid,
          requested_version => (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.main_order')::uuid
          ),
          requested_customer_id => 'f4000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => jsonb_build_array(
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_receivables
                WHERE
                  order_id = current_setting('test.main_order')::uuid
                  AND name = '团款'
              ),
              'name',
              '团款',
              'amount',
              2000
            )
          ),
          requested_payables => '[]'::jsonb,
          requested_route_name => '线路B'
        )
    ),
    'LINE_AMOUNT_CONFLICT',
    'an amount below the confirmed payment is refused with a stable error code'
  );


SELECT
  IS (
    (
      SELECT
        amount
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
        AND name = '团款'
    ),
    5000::numeric(14, 2),
    'the refused change wrote nothing'
  );


-- 4. 直接把这一行从请求里去掉：有确认金额，必须拒绝。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.main_order')::uuid,
          requested_version => (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.main_order')::uuid
          ),
          requested_customer_id => 'f4000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => '[]'::jsonb,
          requested_payables => '[]'::jsonb,
          requested_route_name => '线路B'
        )
    ),
    'LINE_HAS_PAYMENTS',
    'a line that already received money cannot be dropped from the payload'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
    ),
    1,
    'the refused delete left the line in place'
  );


-- 5. 不带 id 的行是新增。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.main_order')::uuid,
          requested_version => (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.main_order')::uuid
          ),
          requested_customer_id => 'f4000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => jsonb_build_array(
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_receivables
                WHERE
                  order_id = current_setting('test.main_order')::uuid
                  AND name = '团款'
              ),
              'name',
              '团款',
              'amount',
              5000
            ),
            jsonb_build_object('name', '单房差', 'amount', 600)
          ),
          requested_payables => '[]'::jsonb,
          requested_route_name => '线路B'
        )
    ),
    NULL,
    'a line without an id is inserted as a new line'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
    ),
    2,
    'the new line now sits next to the existing one'
  );


SELECT
  IS (
    (
      SELECT
        receivable_total
      FROM
        public.orders
      WHERE
        id = current_setting('test.main_order')::uuid
    ),
    5600::numeric(14, 2),
    'totals include the newly inserted line'
  );


-- 6. 拿另一张订单的行 id 冒充本单的行：必须报「不属于本订单」，
--    否则只要猜到 id 就能改到别人的行。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.main_order')::uuid,
          requested_version => (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.main_order')::uuid
          ),
          requested_customer_id => 'f4000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => jsonb_build_array(
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_receivables
                WHERE
                  order_id = current_setting('test.other_order')::uuid
              ),
              'name',
              '冒名行',
              'amount',
              1
            )
          ),
          requested_payables => '[]'::jsonb,
          requested_route_name => '线路B'
        )
    ),
    'LINE_NOT_FOUND',
    'a line id that belongs to another order is rejected'
  );


-- 7. 同一个 id 出现两次：写两次的结果取决于执行顺序，直接拒绝。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.main_order')::uuid,
          requested_version => (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.main_order')::uuid
          ),
          requested_customer_id => 'f4000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => jsonb_build_array(
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_receivables
                WHERE
                  order_id = current_setting('test.main_order')::uuid
                  AND name = '团款'
              ),
              'name',
              '团款',
              'amount',
              5000
            ),
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_receivables
                WHERE
                  order_id = current_setting('test.main_order')::uuid
                  AND name = '团款'
              ),
              'name',
              '团款重复',
              'amount',
              1
            )
          ),
          requested_payables => '[]'::jsonb,
          requested_route_name => '线路B'
        )
    ),
    'LINE_DUPLICATE',
    'the same line id twice in one request is rejected'
  );


-- 8. 没有收付款的行可以正常删除。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.main_order')::uuid,
          requested_version => (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.main_order')::uuid
          ),
          requested_customer_id => 'f4000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => jsonb_build_array(
            jsonb_build_object(
              'id',
              (
                SELECT
                  id
                FROM
                  public.order_receivables
                WHERE
                  order_id = current_setting('test.main_order')::uuid
                  AND name = '团款'
              ),
              'name',
              '团款',
              'amount',
              5000
            )
          ),
          requested_payables => '[]'::jsonb,
          requested_route_name => '线路B'
        )
    ),
    NULL,
    'a line without payments can be removed'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
    ),
    1,
    'the unpaid line is gone'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.main_order')::uuid
        AND name = '团款'
    ),
    3000::numeric(14, 2),
    'the confirmed payment is still 3000 after the whole sequence'
  );


SELECT
  IS (
    (
      SELECT
        receivable_total
      FROM
        public.orders
      WHERE
        id = current_setting('test.main_order')::uuid
    ),
    5000::numeric(14, 2),
    'totals follow the surviving line'
  );


SELECT
  *
FROM
  finish ();