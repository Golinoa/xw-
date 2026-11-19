-- B5 CRM 线索转订单 + 阶段统计。
--
-- 两个必须钉死的点：
-- 1. 重复转换返回同一张订单（不是「又建了一张」）；
-- 2. 转出来的订单是预订单且金额为 0 —— 线索里的预算区间是意向，不是应收。
BEGIN;


SELECT
  plan (9);


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
    'e8000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'lead-order-admin@example.test',
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
    'e9000000-0000-4000-8000-000000000001',
    'lead order org',
    'e8000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'e9000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'admin'
  );


-- 三条线索：可转的、版本不对的、阶段不到的。
INSERT INTO
  public.leads (
    id,
    organization_id,
    name,
    phone,
    destination,
    expected_date,
    adult_count,
    child_count,
    stage,
    owner_id,
    version
  )
VALUES
  (
    'ea000000-0000-4000-8000-000000000001',
    'e9000000-0000-4000-8000-000000000001',
    '李先生',
    '13900000101',
    '云南',
    '2026-12-20',
    2,
    1,
    'won',
    'e8000000-0000-4000-8000-000000000001',
    3
  ),
  (
    'ea000000-0000-4000-8000-000000000002',
    'e9000000-0000-4000-8000-000000000001',
    '版本冲突',
    '13900000102',
    '海南',
    '2026-12-21',
    2,
    0,
    'won',
    'e8000000-0000-4000-8000-000000000001',
    2
  ),
  (
    'ea000000-0000-4000-8000-000000000003',
    'e9000000-0000-4000-8000-000000000001',
    '还在谈',
    '13900000103',
    '贵州',
    '2026-12-22',
    2,
    0,
    'contacting',
    'e8000000-0000-4000-8000-000000000001',
    1
  );


SET LOCAL role authenticated;


SELECT
  set_config (
    'request.jwt.claims',
    '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config ('request.headers', '{"x-organization-id":"e9000000-0000-4000-8000-000000000001"}', TRUE);


-- 1. won 的线索能转出订单
SELECT
  ok (
    (
      SELECT
        result_order_id IS NOT NULL
        AND error_code IS NULL
      FROM
        public.convert_lead_to_order (
          'ea000000-0000-4000-8000-000000000001',
          3,
          '客户要求双飞'
        )
    ),
    'a won lead converts to an order'
  );


SELECT
  set_config (
    'test.order',
    (
      SELECT
        converted_order_id::text
      FROM
        public.leads
      WHERE
        id = 'ea000000-0000-4000-8000-000000000001'
    ),
    TRUE
  );


-- 2. 订单类型是预订单，金额为 0（预算不是应收）
SELECT
  IS (
    (
      SELECT
        order_type
      FROM
        public.orders
      WHERE
        id = current_setting('test.order')::uuid
    ),
    'booking',
    'the generated order is a booking'
  );


SELECT
  IS (
    (
      SELECT
        receivable_total
      FROM
        public.orders
      WHERE
        id = current_setting('test.order')::uuid
    ),
    0::numeric,
    'no amount is invented from the lead budget'
  );


-- 3. 人数与路线名沿用了线索
SELECT
  IS (
    (
      SELECT
        pg_catalog.concat_ws(
          '/',
          adult_count,
          child_count,
          route_name
        )
      FROM
        public.orders
      WHERE
        id = current_setting('test.order')::uuid
    ),
    '2/1/云南',
    'person counts and route name come from the lead'
  );


-- 4. 幂等：再调一次返回同一张单
SELECT
  IS (
    (
      SELECT
        result_order_id
      FROM
        public.convert_lead_to_order ('ea000000-0000-4000-8000-000000000001', 3, NULL)
    ),
    current_setting('test.order')::uuid,
    'converting twice returns the same order'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        public.orders
      WHERE
        id = current_setting('test.order')::uuid
    ),
    1::bigint,
    'no duplicate order is created'
  );


-- 5. 版本不对要拒
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.convert_lead_to_order ('ea000000-0000-4000-8000-000000000002', 99, NULL)
    ),
    'VERSION_CONFLICT',
    'a stale version is rejected'
  );


-- 6. 阶段不到要拒
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.convert_lead_to_order ('ea000000-0000-4000-8000-000000000003', 1, NULL)
    ),
    'STAGE_NOT_WON',
    'a lead that has not won cannot be ordered'
  );


-- 7. 阶段统计：区间内 3 条线索，已经转出 1 单
SELECT
  ok (
    (
      SELECT
        (public.lead_funnel (current_date - 1, current_date + 1) ->> 'total')::int = 3
        AND (public.lead_funnel (current_date - 1, current_date + 1) ->> 'convertedOrders')::int = 1
        AND (public.lead_funnel (current_date - 1, current_date + 1) -> 'stages' ->> 'won')::int = 2
    ),
    'the funnel counts leads by current stage in range'
  );


ROLLBACK;
