-- 订单域：服务端金额重算、状态机、供应商可用性、数据范围。
--
-- 这些规则全在 plpgsql 函数里，只有真跑一遍才知道「合计是从明细算的」
-- 这种说法成不成立——读代码很容易把顺序看反。
BEGIN;


SELECT
  plan (16);


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
    'd1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'order-admin@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'd1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'order-operator@example.test',
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
    'd2000000-0000-4000-8000-000000000001',
    'order org',
    'd1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'd2000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    'admin'
  ),
  (
    'd2000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000002',
    'operator'
  );


-- 两个客户分别属于两个操作者：own 范围下操作员连客户都读不到，
-- 这决定了「能不能用别人的客户下单」。
INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'd3000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001',
    '管理员的客户',
    '13900000001',
    'd1000000-0000-4000-8000-000000000001'
  ),
  (
    'd3000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    '操作员的客户',
    '13900000002',
    'd1000000-0000-4000-8000-000000000002'
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
    'd4000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001',
    '启用中的地接社',
    'transport',
    'per_trip',
    TRUE
  ),
  (
    'd4000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    '已停用的地接社',
    'transport',
    'per_trip',
    FALSE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"d2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  lives_ok (
    $sql$
    SELECT public.create_order_with_items (
      'd3000000-0000-4000-8000-000000000001',
      'booking',
      '[{"name":"团款","amount":7500}]'::jsonb,
      '[{"name":"地接","amount":4800,"supplierId":"d4000000-0000-4000-8000-000000000001"}]'::jsonb,
      '线路A',
      '2026-11-01',
      '2026-11-08',
      2,
      1
    )
    $sql$,
    'admin can create an order with receivable and payable lines'
  );


SELECT
  ok (
    (
      SELECT
        order_number
      FROM
        public.orders
      WHERE
        route_name = '线路A'
    ) ~ '^SO-[0-9]{8}-[0-9]{6}$',
    'order number follows SO-YYYYMMDD-NNNNNN'
  );


SELECT
  IS (
    (
      SELECT
        person_count
      FROM
        public.orders
      WHERE
        route_name = '线路A'
    ),
    3,
    'person count is generated from adult and child counts'
  );


SELECT
  IS (
    (
      SELECT
        receivable_total
      FROM
        public.orders
      WHERE
        route_name = '线路A'
    ),
    7500.00,
    'receivable total is summed from the receivable lines'
  );


SELECT
  IS (
    (
      SELECT
        payable_total
      FROM
        public.orders
      WHERE
        route_name = '线路A'
    ),
    4800.00,
    'payable total is summed from the payable lines'
  );


SELECT
  IS (
    (
      SELECT
        profit
      FROM
        public.orders
      WHERE
        route_name = '线路A'
    ),
    2700.00,
    'profit is a generated column, never accepted from the caller'
  );


SELECT
  IS (
    (
      SELECT
        available_amount
      FROM
        public.order_receivables
      WHERE
        name = '团款'
    ),
    7500.00,
    'available amount starts at the full amount when nothing is confirmed'
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.transition_order_status (
          (
            SELECT
              id
            FROM
              public.orders
            WHERE
              route_name = '线路A'
          ),
          'confirm',
          1
        )
    ),
    'active',
    'confirm moves a booking order to active'
  );


-- 订单此时 version = 2；拿旧版本号提交必须被拒绝而不是覆盖。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.transition_order_status (
          (
            SELECT
              id
            FROM
              public.orders
            WHERE
              route_name = '线路A'
          ),
          'confirm',
          1
        )
    ),
    'VERSION_CONFLICT',
    'a stale version is rejected instead of overwriting'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.transition_order_status (
          (
            SELECT
              id
            FROM
              public.orders
            WHERE
              route_name = '线路A'
          ),
          'confirm',
          2
        )
    ),
    'ORDER_STATE_CONFLICT',
    'an illegal transition reports a state conflict instead of raising'
  );


SELECT
  throws_like (
    $sql$
    SELECT public.create_order_with_items (
      'd3000000-0000-4000-8000-000000000001',
      'active',
      '[]'::jsonb,
      '[{"name":"地接","amount":100,"supplierId":"d4000000-0000-4000-8000-000000000002"}]'::jsonb,
      '线路B'
    )
    $sql$,
    '%supplier_not_available%',
    'a disabled supplier cannot be referenced by a new order'
  );


-- 换成操作员（数据范围 own）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  lives_ok (
    $sql$
    SELECT public.create_order_with_items (
      'd3000000-0000-4000-8000-000000000002',
      'booking',
      '[]'::jsonb,
      '[]'::jsonb,
      '线路C'
    )
    $sql$,
    'operator can create an order for their own customer'
  );


SELECT
  IS (
    (
      SELECT
        status
      FROM
        public.orders
      WHERE
        route_name = '线路C'
    ),
    'booking',
    'a booking order starts in the booking status'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.orders
    ),
    1,
    'operator sees only the order they created'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.orders
      WHERE
        route_name = '线路A'
    ),
    0,
    'operator cannot read an order created by someone else'
  );


-- 「金额只由服务端算」不能只是约定：直接写金额列必须被列级授权挡住。
SELECT
  throws_like (
    $sql$
    INSERT INTO public.orders (organization_id, order_number, order_type, status, customer_id, created_by, receivable_total)
    VALUES ('d2000000-0000-4000-8000-000000000001', 'SO-19700101-999999', 'active', 'active', 'd3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 999999)
    $sql$,
    '%permission denied%',
    'clients cannot write the order total columns directly'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;