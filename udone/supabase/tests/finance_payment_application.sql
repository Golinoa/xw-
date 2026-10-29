-- 付款路径（R-FIN-03）。
--
-- `finance_application_flow.sql` 只走了收款。付款共用同一组函数，但「共用一个函数」
-- 不等于「共用一份证据」：两边的分支是 else 里的两段 UPDATE，写错一侧不会有任何
-- 断言变红。这个文件专门覆盖应收之外的另一半。
--
-- 两处刻意的写法差异：
-- 1. 全部用**命名参数**调用（requested_kind => ...）。API 服务层是通过 PostgREST
--    的 JSON key 匹配参数名的，参数改名不会有编译错误，只会在线上 500。用命名参数
--    调用就把「参数名」也变成了被断言的东西。
-- 2. 每条金额变动都同时断言 confirmed / pending / available 三个数，
--    不只断言"变对了的那一个"——只对一半的情况才是最难查的。
BEGIN;


SELECT
  plan (28);


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
    'pay-operator@example.test',
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
    'pay-finance@example.test',
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
    'pay-admin@example.test',
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
    '付款测试公司',
    'c1000000-0000-4000-8000-000000000003'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000002',
    'finance'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000003',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'c3000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    '付款测试客户',
    '13900000061',
    'c1000000-0000-4000-8000-000000000001'
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
    'c4000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    '付款测试地接',
    'transport',
    'per_trip',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"c2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.order',
    (
      SELECT
        public.create_order_with_items (
          'c3000000-0000-4000-8000-000000000001',
          'booking',
          '[{"name":"团款","amount":7500}]'::jsonb,
          '[{"name":"地接","amount":4800,"supplierId":"c4000000-0000-4000-8000-000000000001"}]'::jsonb,
          '付款测试订单',
          '2027-01-05',
          '2027-01-12',
          2,
          0
        )::text
    ),
    TRUE
  );


SELECT
  set_config(
    'test.pay',
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


-- 全额申请：4800 全部进入在途。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_finance_application (
          requested_kind => 'payment',
          requested_order_id => current_setting('test.order')::uuid,
          requested_line_id => current_setting('test.pay')::uuid,
          requested_amount => 4800,
          requested_method => 'bank',
          requested_occurred_on => '2027-01-06'::date,
          requested_reference_no => 'PAY-0001',
          requested_voucher_url => NULL,
          requested_remark => '地接全款'
        )
    ) IS NULL,
    TRUE,
    'a payment application is created with named arguments'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    4800.00,
    'the payable line holds the whole payment while it waits'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    0.00,
    'a pending payment is not money paid out yet'
  );


SELECT
  IS (
    (
      SELECT
        available_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    0.00,
    'a full payment leaves nothing applicable on the line'
  );


-- 边界：余额已经被占满，哪怕再申请 0.01 也必须被拒。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_finance_application (
          requested_kind => 'payment',
          requested_order_id => current_setting('test.order')::uuid,
          requested_line_id => current_setting('test.pay')::uuid,
          requested_amount => 0.01,
          requested_method => 'cash',
          requested_occurred_on => '2027-01-06'::date
        )
    ),
    'AMOUNT_EXCEEDS_AVAILABLE',
    'one cent above the remaining amount is still rejected'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_finance_application (
          requested_kind => 'payment',
          requested_order_id => current_setting('test.order')::uuid,
          requested_line_id => current_setting('test.pay')::uuid,
          requested_amount => 0,
          requested_method => 'cash',
          requested_occurred_on => '2027-01-06'::date
        )
    ),
    'AMOUNT_INVALID',
    'a zero payment is rejected rather than silently accepted'
  );


-- 收付类型与明细表必须对得上：拿应付行 id 报一笔收款，等于把钱记到不存在的科目上。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_finance_application (
          requested_kind => 'receipt',
          requested_order_id => current_setting('test.order')::uuid,
          requested_line_id => current_setting('test.pay')::uuid,
          requested_amount => 100,
          requested_method => 'cash',
          requested_occurred_on => '2027-01-06'::date
        )
    ),
    'LINE_NOT_FOUND',
    'a receipt cannot be attached to a payable line'
  );


-- 有待审付款的行不允许被订单编辑顺手删掉。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_order_with_items (
          requested_order_id => current_setting('test.order')::uuid,
          requested_version => 1,
          requested_customer_id => 'c3000000-0000-4000-8000-000000000001',
          requested_order_type => 'booking',
          requested_receivables => '[{"name":"团款","amount":7500}]'::jsonb,
          requested_payables => '[]'::jsonb,
          requested_route_name => '付款测试订单',
          requested_departure_date => '2027-01-05',
          requested_return_date => '2027-01-12',
          requested_adult_count => 2,
          requested_child_count => 0,
          requested_remark => NULL
        )
    ),
    'LINE_HAS_PAYMENTS',
    'a line with a pending payment cannot be deleted by an order edit'
  );


SELECT
  set_config(
    'test.app',
    (
      SELECT
        id::text
      FROM
        public.finance_applications
      WHERE
        organization_id = 'c2000000-0000-4000-8000-000000000001'
    ),
    TRUE
  );


-- 财务审第一级：状态仍是待审，级次推进，金额留在在途。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status || '/' || new_step
      FROM
        public.decide_finance_application (
          requested_application_id => current_setting('test.app')::uuid,
          requested_action => 'approve',
          requested_opinion => '供应商发票已核对',
          requested_version => 1
        )
    ),
    'pending/2',
    'the finance role moves a payment to the second step without paying it'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    4800.00,
    'the amount is still held after the first approval'
  );


SELECT
  throws_like (
    $sql$
    SELECT * FROM public.decide_finance_application (
      requested_application_id => current_setting('test.app')::uuid,
      requested_action => 'approve',
      requested_opinion => '越权终审',
      requested_version => 2
    )
    $sql$,
    '%administrator%',
    'the finance role cannot give the final approval on a payment'
  );


-- 终审：在途转入已付。
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
        new_status
      FROM
        public.decide_finance_application (
          requested_application_id => current_setting('test.app')::uuid,
          requested_action => 'approve',
          requested_opinion => NULL,
          requested_version => 2
        )
    ),
    'approved',
    'the administrator gives the final approval on a payment'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    4800.00,
    'the final approval marks the payment as paid'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    0.00,
    'the in-flight amount is cleared once the payment is approved'
  );


-- 三个数必须同时成立：金额 = 已付 + 在途 + 可申请。
SELECT
  IS (
    (
      SELECT
        amount - confirmed_amount - pending_amount - available_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    0.00,
    'amount equals paid plus in-flight plus applicable on the payable line'
  );


-- 撤销终审：已付金额退回在途，而不是退回可申请余额——
-- 钱已经付出去了，"撤销审批"是回到复核，不是宣布这笔钱没花。
SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.undo_finance_application (
          requested_application_id => current_setting('test.app')::uuid,
          requested_reason => '银行退回，需重新核对',
          requested_version => 3
        )
    ),
    'pending',
    'undoing a final approval returns the payment to the review queue'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    0.00,
    'undoing clears the paid amount'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    4800.00,
    'undoing puts the amount back in flight instead of releasing it'
  );


SELECT
  IS (
    (
      SELECT
        available_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    0.00,
    'undoing does not free the line for a second application'
  );


-- 轨迹只追加：通过、通过、撤销各一行。
SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.finance_application_actions
      WHERE
        application_id = current_setting('test.app')::uuid
    ),
    3,
    'every decision leaves its own row in the trail'
  );


-- 没有审批权限的角色连这一步都进不来。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_like (
    $sql$
    SELECT * FROM public.decide_finance_application (
      requested_application_id => current_setting('test.app')::uuid,
      requested_action => 'approve',
      requested_opinion => NULL,
      requested_version => 4
    )
    $sql$,
    '%finance.approve is required%',
    'an operator cannot approve a payment application'
  );


-- 只有创建人能撤回：财务拿着 finance.write 也不行。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_like (
    $sql$
    SELECT * FROM public.withdraw_finance_application (
      requested_application_id => current_setting('test.app')::uuid,
      requested_reason => '不是我的申请',
      requested_version => 4
    )
    $sql$,
    '%only the creator can withdraw%',
    'a non creator cannot withdraw a payment application'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.withdraw_finance_application (
          requested_application_id => current_setting('test.app')::uuid,
          requested_reason => '供应商改走月结',
          requested_version => 4
        )
    ),
    'withdrawn',
    'the creator withdraws the payment application'
  );


SELECT
  IS (
    (
      SELECT
        available_amount
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay')::uuid
    ),
    4800.00,
    'withdrawing frees the payable line again'
  );


-- 陈旧版本号：别人已经处理过，这一次必须失败而不是覆盖。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_finance_application (
          requested_kind => 'payment',
          requested_order_id => current_setting('test.order')::uuid,
          requested_line_id => current_setting('test.pay')::uuid,
          requested_amount => 1000,
          requested_method => 'cash',
          requested_occurred_on => '2027-01-07'::date
        )
    ),
    NULL,
    'a fresh payment application is created for the version check'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.decide_finance_application (
          requested_application_id => (
            SELECT
              id
            FROM
              public.finance_applications
            WHERE
              status = 'pending'
              AND amount = 1000
          ),
          requested_action => 'approve',
          requested_opinion => NULL,
          requested_version => 99
        )
    ),
    'VERSION_CONFLICT',
    'a stale version is refused instead of overwriting a decision'
  );


-- 已取消的订单不再产生资金流动。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.cancelled',
    (
      SELECT
        public.create_order_with_items (
          'c3000000-0000-4000-8000-000000000001',
          'booking',
          '[{"name":"团款","amount":1000}]'::jsonb,
          '[{"name":"包车","amount":800,"supplierId":"c4000000-0000-4000-8000-000000000001"}]'::jsonb,
          '待取消订单',
          '2027-02-01',
          '2027-02-03',
          1,
          0
        )::text
    ),
    TRUE
  );


SELECT
  public.transition_order_status (
    requested_order_id => current_setting('test.cancelled')::uuid,
    requested_action => 'cancel',
    requested_version => 1,
    requested_reason => '客户取消'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_finance_application (
          requested_kind => 'payment',
          requested_order_id => current_setting('test.cancelled')::uuid,
          requested_line_id => (
            SELECT
              id
            FROM
              public.order_payables
            WHERE
              order_id = current_setting('test.cancelled')::uuid
          ),
          requested_amount => 800,
          requested_method => 'bank',
          requested_occurred_on => '2027-01-07'::date
        )
    ),
    'ORDER_STATE_CONFLICT',
    'a cancelled order accepts no new payment application'
  );


-- 跨租户：另一个组织的申请 id 必须读不到。
-- 必须用有 finance.approve 的身份来测：操作员会先被权限检查挡下（42501），
-- 那样断言虽然也"失败"了，但失败原因是权限而不是租户隔离，等于什么都没证明。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.foreign',
    'c9000000-0000-4000-8000-000000000009',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.decide_finance_application (
          requested_application_id => current_setting('test.foreign')::uuid,
          requested_action => 'approve',
          requested_opinion => NULL,
          requested_version => 1
        )
    ),
    'NOT_FOUND',
    'an application from another organization is not addressable'
  );


SELECT
  *
FROM
  finish ();