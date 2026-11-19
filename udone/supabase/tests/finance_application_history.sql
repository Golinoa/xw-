-- B1：审批轨迹不随明细行删除消失。
--
-- 覆盖的是「删行 → 轨迹还在」这条路径，两侧各走一遍（应收 + 应付）：
-- 1. 用真实入口 update_order_with_items 删行，而不是直接 DELETE ——
--    守卫（LINE_HAS_PAYMENTS）和脱钩触发器都在这个函数调用的路径上，
--    绕过它测出来的绿是假的。
-- 2. 每一侧都断言四件事：行没了、申请还在、引用被置空、轨迹还在。
--    只断「申请还在」是不够的：引用没置空说明外键走到了别的分支。
BEGIN;


SELECT
  plan (20);


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
    'history-operator@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'history-finance@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'history-admin@example.test',
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
    'history org',
    'b1000000-0000-4000-8000-000000000003'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002',
    'finance'
  ),
  (
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000003',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'b3000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001',
    '历史测试客户',
    '13900000051',
    'b1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.suppliers (id, organization_id, name, type, settlement, is_active)
VALUES
  (
    'b4000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001',
    '历史测试地接',
    'transport',
    'per_trip',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"b2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'b3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":7500}]'::jsonb,
    '[{"name":"地接","amount":4800,"supplierId":"b4000000-0000-4000-8000-000000000001"}]'::jsonb,
    '历史测试订单',
    '2026-12-20',
    '2026-12-27',
    2,
    1
  );


SELECT
  set_config(
    'test.order',
    (
      SELECT
        id::text
      FROM
        public.orders
      WHERE
        route_name = '历史测试订单'
    ),
    TRUE
  );


SELECT
  set_config(
    'test.receivable',
    (
      SELECT
        id::text
      FROM
        public.order_receivables
      WHERE
        order_id = current_setting('test.order')::uuid
        AND name = '团款'
    ),
    TRUE
  );


SELECT
  set_config(
    'test.payable',
    (
      SELECT
        id::text
      FROM
        public.order_payables
      WHERE
        order_id = current_setting('test.order')::uuid
        AND name = '地接'
    ),
    TRUE
  );


-- ---------------------------------------------------------------- 应收侧
SELECT
  set_config(
    'test.app_receipt',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.receivable')::uuid,
          3000,
          'bank',
          '2026-12-21',
          'SN-B1-1',
          NULL,
          '待驳回'
        )
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        status
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_receipt')::uuid
    ),
    'pending',
    'the receipt application starts pending'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.receivable')::uuid
    ),
    3000::numeric,
    'the pending application occupies the line capacity'
  );


-- 审批权在财务，写单在操作员：两个身份分别切换，不能混着用。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.decide_finance_application (
          current_setting('test.app_receipt')::uuid,
          'reject',
          '金额对不上',
          1
        )
    ),
    'rejected',
    'the operator rejection reaches a terminal state'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.receivable')::uuid
    ),
    0::numeric,
    'a rejected application releases the capacity'
  );


-- 走真实入口删行：把应收列表给空，保留应付。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          current_setting('test.order')::uuid,
          (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.order')::uuid
          ),
          'b3000000-0000-4000-8000-000000000001',
          'booking',
          '[]'::jsonb,
          (
            SELECT
              pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                  'id',
                  current_setting('test.payable'),
                  'name',
                  '地接',
                  'amount',
                  4800,
                  'supplierId',
                  'b4000000-0000-4000-8000-000000000001'
                )
              )
          ),
          '历史测试订单',
          '2026-12-20',
          '2026-12-27',
          2,
          1
        )
    ),
    NULL,
    'deleting a line whose only application is terminal is allowed'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.receivable')::uuid
    ),
    0,
    'the receivable line is gone'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_receipt')::uuid
    ),
    1,
    'the rejected application survives the line deletion'
  );


SELECT
  IS (
    (
      SELECT
        line_name
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_receipt')::uuid
    ),
    '团款',
    'the application keeps the original line name after the line is gone'
  );




SELECT
  IS (
    (
      SELECT
        status
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_receipt')::uuid
    ),
    'rejected',
    'the surviving application keeps its terminal status'
  );


SELECT
  IS (
    (
      SELECT
        receivable_id
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_receipt')::uuid
    ),
    NULL::uuid,
    'the detached application no longer points at the deleted line'
  );


SELECT
  IS (
    (
      SELECT
        order_id
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_receipt')::uuid
    ),
    current_setting('test.order')::uuid,
    'the detached application still points at its order'
  );


-- ---------------------------------------------------------------- 应付侧
SELECT
  set_config(
    'test.app_payment',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'payment',
          current_setting('test.order')::uuid,
          current_setting('test.payable')::uuid,
          1000,
          'bank',
          '2026-12-22',
          'SN-B1-2',
          NULL,
          '待驳回'
        )
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        status
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_payment')::uuid
    ),
    'pending',
    'the payment application starts pending'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.payable')::uuid
    ),
    1000::numeric,
    'the pending payment occupies the payable capacity'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.decide_finance_application (
          current_setting('test.app_payment')::uuid,
          'reject',
          '供应商结算方式有误',
          1
        )
    ),
    'rejected',
    'the payment rejection reaches a terminal state'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.payable')::uuid
    ),
    0::numeric,
    'the rejected payment releases the payable capacity'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          current_setting('test.order')::uuid,
          (
            SELECT
              version
            FROM
              public.orders
            WHERE
              id = current_setting('test.order')::uuid
          ),
          'b3000000-0000-4000-8000-000000000001',
          'booking',
          '[]'::jsonb,
          '[]'::jsonb,
          '历史测试订单',
          '2026-12-20',
          '2026-12-27',
          2,
          1
        )
    ),
    NULL,
    'deleting the payable line is allowed once its application is terminal'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.payable')::uuid
    ),
    0,
    'the payable line is gone'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_payment')::uuid
    ),
    1,
    'the rejected payment application survives the line deletion'
  );


SELECT
  IS (
    (
      SELECT
        payable_id
      FROM
        public.finance_applications
      WHERE
        id = current_setting('test.app_payment')::uuid
    ),
    NULL::uuid,
    'the detached payment application no longer points at the deleted line'
  );


-- 轨迹是这一整条改动的目的：两侧各一条驳回记录，都必须留下来。
-- 用管理员身份读：操作员看不到审批轨迹（策略按权限限定），
-- 拿操作员的视角断言「轨迹还在」会得到 0 行，测不出真东西。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"b1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count(*)::integer
      FROM
        public.finance_application_actions
      WHERE
        organization_id = 'b2000000-0000-4000-8000-000000000001'
    ),
    2,
    'both rejection records survive their lines'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
