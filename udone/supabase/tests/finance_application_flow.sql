-- 收付款申请与审批（R-FIN-02 / R-APPROVAL-02）。
--
-- 这里要守住的不变式只有三条，但每条都能被错误的实现破坏：
--   1. amount = confirmed + pending + available 恒成立，超额申请必须失败
--   2. 待审只占额度不计收入；终审通过才把 pending 挪进 confirmed
--   3. 驳回、撤销、终审撤回都必须把额度还回去，一分不多一分不少
--
-- 顺序有讲究：先申请到上限，再验证超额被拒；先走完两级审批，再撤回，
-- 这样每一笔金额变化都能和上一状态对上，出问题能定位到具体那一步。
BEGIN;


SELECT
  plan (19);


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
    'app-operator@example.test',
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
    'app-finance@example.test',
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
    'app-admin@example.test',
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
    'application org',
    'a1000000-0000-4000-8000-000000000003'
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
    'finance'
  ),
  (
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000003',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'a3000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    '申请测试客户',
    '13900000041',
    'a1000000-0000-4000-8000-000000000001'
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
    'a4000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    '申请测试地接',
    'transport',
    'per_trip',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"a2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'a3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":7500}]'::jsonb,
    '[{"name":"地接","amount":4800,"supplierId":"a4000000-0000-4000-8000-000000000001"}]'::jsonb,
    '申请测试订单',
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
        route_name = '申请测试订单'
    ),
    TRUE
  );


SELECT
  set_config(
    'test.line',
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


-- 操作员提交 3000 元收款申请：占用额度，但不计入已收。
SELECT
  set_config(
    'test.app1',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          3000,
          'bank',
          '2026-12-21',
          'SN-0001',
          NULL,
          '首付款'
        )
    ),
    TRUE
  );


SELECT
  ok (
    current_setting('test.app1') IS NOT NULL,
    'an operator can submit a receipt application'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.line')::uuid
    ),
    3000.00,
    'a pending application holds its amount without confirming it'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.line')::uuid
    ),
    0.00,
    'a pending application is not revenue yet'
  );


SELECT
  IS (
    (
      SELECT
        available_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.line')::uuid
    ),
    4500.00,
    'available amount drops by the pending amount'
  );


-- 剩余可收 4500，申请 5000 必须被拦下，且不能留下任何痕迹。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          5000,
          'bank',
          '2026-12-21',
          NULL,
          NULL,
          NULL
        )
    ),
    'AMOUNT_EXCEEDS_AVAILABLE',
    'an application above the remaining amount is rejected'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.finance_applications
    ),
    1,
    'the rejected application did not create a row'
  );


-- 财务审第一级：状态仍是待审，只是推进到第二级，额度不动。
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
        new_status || '/' || new_step
      FROM
        public.decide_finance_application (
          current_setting('test.app1')::uuid,
          'approve',
          '财务核对无误',
          1
        )
    ),
    'pending/2',
    'the first approval advances the step without confirming'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.line')::uuid
    ),
    3000.00,
    'the amount is still held after the first approval'
  );


-- 终审需要管理员级权限，财务在这一步必须被拒。
SELECT
  throws_like (
    $sql$
    SELECT * FROM public.decide_finance_application (current_setting('test.app1')::uuid, 'approve', '越权终审', 2)
    $sql$,
    '%administrator%',
    'the finance role cannot perform the final approval'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.decide_finance_application (
          current_setting('test.app1')::uuid,
          'approve',
          '终审通过',
          2
        )
    ),
    'approved',
    'the final approval confirms the application'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount || '/' || pending_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.line')::uuid
    ),
    '3000.00/0.00',
    'the held amount moves into confirmed on final approval'
  );


-- 撤回终审：确认金额退回在途，状态回到第二级待办。
SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.undo_finance_application (current_setting('test.app1')::uuid, '客户撤销该笔汇款', 3)
    ),
    'pending',
    'undoing the final approval returns the application to pending'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount || '/' || pending_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.line')::uuid
    ),
    '0.00/3000.00',
    'undoing moves the amount back to held instead of releasing it'
  );


-- 驳回必须写原因；写了原因才释放额度。
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
        error_code
      FROM
        public.decide_finance_application (
          current_setting('test.app1')::uuid,
          'reject',
          NULL,
          4
        )
    ),
    'REASON_REQUIRED',
    'rejecting without a reason is refused'
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.decide_finance_application (
          current_setting('test.app1')::uuid,
          'reject',
          '流水号无法核对',
          4
        )
    ),
    'rejected',
    'rejecting with a reason succeeds'
  );


SELECT
  IS (
    (
      SELECT
        confirmed_amount || '/' || pending_amount || '/' || available_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.line')::uuid
    ),
    '0.00/0.00/7500.00',
    'rejection releases the whole amount back to available'
  );


-- 创建人撤销待审申请，同样释放额度。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.app2',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          1000,
          'cash',
          '2026-12-22',
          NULL,
          NULL,
          NULL
        )
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.withdraw_finance_application (current_setting('test.app2')::uuid, '金额填错', 1)
    ),
    'withdrawn',
    'the creator can withdraw a pending application'
  );


SELECT
  IS (
    (
      SELECT
        pending_amount
      FROM
        public.order_receivables
      WHERE
        id = current_setting('test.line')::uuid
    ),
    0.00,
    'withdrawing releases the held amount'
  );


-- 同级自顾：管理员自己提交的申请，管理员不能自己批。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.app3',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          500,
          'cash',
          '2026-12-23',
          NULL,
          NULL,
          NULL
        )
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.decide_finance_application (
          current_setting('test.app3')::uuid,
          'approve',
          '自己批自己',
          1
        )
    ),
    'SELF_APPROVAL_FORBIDDEN',
    'an applicant cannot approve their own application'
  );


SELECT
  *
FROM
  finish ();