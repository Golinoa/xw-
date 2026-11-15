-- C1 审批流配置化：配置表 + 实例快照 + 引擎按快照推进。
--
-- 最关键的一条断言是「改配置不改变在途实例」：
-- 先按默认 2 级提交一张申请，再把机构配置改成 3 级，
-- 然后证明那张**已提交**的申请仍然只需 2 级就能终审 ——
-- 只断「新申请走 3 级」是不够的，那样配置表直接覆盖旧行也能测绿。
BEGIN;


SELECT
  plan (14);


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
    'flow-operator@example.test',
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
    'flow-finance@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'd1000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'flow-admin@example.test',
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
    'flow org',
    'd1000000-0000-4000-8000-000000000003'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'd2000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'd2000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000002',
    'finance'
  ),
  (
    'd2000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000003',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'd3000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001',
    '流程测试客户',
    '13900000071',
    'd1000000-0000-4000-8000-000000000001'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"d2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  public.create_order_with_items (
    'd3000000-0000-4000-8000-000000000001',
    'booking',
    '[{"name":"团款","amount":9000}]'::jsonb,
    '[]'::jsonb,
    '流程测试订单',
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
        route_name = '流程测试订单'
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
    ),
    TRUE
  );


-- 默认流程提交一张（配置化之前的行为），先记下来。
SELECT
  set_config(
    'test.app_default',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          500,
          'bank',
          '2026-12-21',
          'SN-C1-1',
          NULL,
          '默认流程'
        )
    ),
    TRUE
  );


SELECT
  IS (
    jsonb_array_length(
      (
        SELECT
          flow_snapshot -> 'steps'
        FROM
          public.finance_applications
        WHERE
          id = current_setting('test.app_default')::uuid
      )
    ),
    2,
    'a request submitted before any configuration keeps the 2-step default'
  );


-- 换成 admin：改流程配置需要 settings.manage。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    public.set_approval_flow (
      '[
        {"step": 1, "permission": "finance.approve"},
        {"step": 2, "permission": "finance.approve"},
        {"step": 3, "permission": "settings.manage"}
      ]'::jsonb,
      FALSE,
      FALSE
    ),
    TRUE,
    'an administrator can save a 3-step flow'
  );


-- 核心断言：改配置之后，在途实例的快照不能变。
SELECT
  IS (
    jsonb_array_length(
      (
        SELECT
          flow_snapshot -> 'steps'
        FROM
          public.finance_applications
        WHERE
          id = current_setting('test.app_default')::uuid
      )
    ),
    2,
    'changing the configuration does not rewrite an in-flight request snapshot'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.app_three',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          500,
          'bank',
          '2026-12-21',
          'SN-C1-2',
          NULL,
          '三级流程'
        )
    ),
    TRUE
  );


SELECT
  IS (
    jsonb_array_length(
      (
        SELECT
          flow_snapshot -> 'steps'
        FROM
          public.finance_applications
        WHERE
          id = current_setting('test.app_three')::uuid
      )
    ),
    3,
    'a request submitted after the change snapshots 3 steps'
  );


-- 三级流程走通：前两级由财务，最后一级由管理员。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status || '/' || new_step
      FROM
        public.decide_finance_application (
          current_setting('test.app_three')::uuid,
          'approve',
          '一级通过',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_three')::uuid
          )
        )
    ),
    'pending/2',
    'step 1 of 3 advances without confirming'
  );


SELECT
  IS (
    (
      SELECT
        new_status || '/' || new_step
      FROM
        public.decide_finance_application (
          current_setting('test.app_three')::uuid,
          'approve',
          '二级通过',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_three')::uuid
          )
        )
    ),
    'pending/3',
    'step 2 of 3 advances without confirming'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.decide_finance_application (
          current_setting('test.app_three')::uuid,
          'approve',
          '终审通过',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_three')::uuid
          )
        )
    ),
    'approved',
    'the third step confirms the amount'
  );


-- 在途实例仍按旧快照走：两张都只用 2 级就能终审。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status || '/' || new_step
      FROM
        public.decide_finance_application (
          current_setting('test.app_default')::uuid,
          'approve',
          '财务通过',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_default')::uuid
          )
        )
    ),
    'pending/2',
    'the in-flight request still advances by its own 2-step snapshot'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.decide_finance_application (
          current_setting('test.app_default')::uuid,
          'approve',
          '管理员终审',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_default')::uuid
          )
        )
    ),
    'approved',
    'the in-flight request finishes at step 2, not 3'
  );


-- ---------------------------------------------------------------- 撤回开关
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.app_nowithdraw',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          500,
          'bank',
          '2026-12-21',
          'SN-C1-3',
          NULL,
          '禁止撤回'
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
        public.withdraw_finance_application (
          current_setting('test.app_nowithdraw')::uuid,
          '不想报了',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_nowithdraw')::uuid
          )
        )
    ),
    'WITHDRAW_NOT_ALLOWED',
    'allowWithdraw = false blocks the creator from withdrawing'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  public.set_approval_flow (
    '[
      {"step": 1, "permission": "finance.approve"},
      {"step": 2, "permission": "finance.approve"},
      {"step": 3, "permission": "settings.manage"}
    ]'::jsonb,
    FALSE,
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


-- 快照在创建时固化，所以「开关打开后」必须**新提一张**才能观察到放行。
-- 拿旧的那张去撤回会得到 WITHDRAW_NOT_ALLOWED——这正是快照该有的行为。
SELECT
  set_config(
    'test.app_withdraw_ok',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          500,
          'bank',
          '2026-12-21',
          'SN-C1-3b',
          NULL,
          '允许撤回'
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
        public.withdraw_finance_application (
          current_setting('test.app_withdraw_ok')::uuid,
          '配置改成允许后撤回',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_withdraw_ok')::uuid
          )
        )
    ),
    'withdrawn',
    'allowWithdraw = true lets a newly submitted request be withdrawn'
  );


-- ---------------------------------------------------------------- 同人审批开关
-- 管理员自己提交、自己审批：默认禁止。
-- created_by 取的是当时的 JWT，所以必须先切成管理员再提交，
-- 否则提交人是操作员，审批人换成管理员就不是「同人」了。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.app_self',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          500,
          'bank',
          '2026-12-21',
          'SN-C1-4',
          NULL,
          '管理员自提'
        )
    ),
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.decide_finance_application (
          current_setting('test.app_self')::uuid,
          'approve',
          '自己批自己',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_self')::uuid
          )
        )
    ),
    'SELF_APPROVAL_FORBIDDEN',
    'self approval stays forbidden by default'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    public.set_approval_flow (
      '[
        {"step": 1, "permission": "finance.approve"},
        {"step": 2, "permission": "finance.approve"},
        {"step": 3, "permission": "settings.manage"}
      ]'::jsonb,
      TRUE,
      TRUE
    ),
    TRUE,
    'the administrator turns self approval on'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.app_self_after',
    (
      SELECT
        result_application_id::text
      FROM
        public.create_finance_application (
          'receipt',
          current_setting('test.order')::uuid,
          current_setting('test.line')::uuid,
          500,
          'bank',
          '2026-12-21',
          'SN-C1-5',
          NULL,
          '开关打开后自提'
        )
    ),
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.decide_finance_application (
          current_setting('test.app_self_after')::uuid,
          'approve',
          '开关打开后自己批',
          (
            SELECT
              version
            FROM
              public.finance_applications
            WHERE
              id = current_setting('test.app_self_after')::uuid
          )
        )
    ),
    'pending',
    'self approval goes through once the switch is on'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
