BEGIN;


SELECT
  plan (34);


-- 夹具：6 个 auth 用户，其中 5 个有运营账号（active ×3 / invited ×1 / disabled ×1），
-- 第 6 个只有租户侧身份（P2 要用）。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'ops-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000a2',
    'authenticated',
    'authenticated',
    'ops-support@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000a3',
    'authenticated',
    'authenticated',
    'ops-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000a4',
    'authenticated',
    'authenticated',
    'ops-invited@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000a5',
    'authenticated',
    'authenticated',
    'ops-disabled@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000b1',
    'authenticated',
    'authenticated',
    'tenant-member@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-0000000000a1',
    'ops-admin@example.test',
    '平台管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-0000000000a2',
    'ops-support@example.test',
    '售后支持',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000103',
    '00000000-0000-4000-8000-0000000000a3',
    'ops-viewer@example.test',
    '运营只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000104',
    '00000000-0000-4000-8000-0000000000a4',
    'ops-invited@example.test',
    '待激活',
    'invited'
  ),
  (
    '00000000-0000-4000-8000-000000000105',
    '00000000-0000-4000-8000-0000000000a5',
    'ops-disabled@example.test',
    '已停用',
    'disabled'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  seed.operator_id,
  role.id,
  '00000000-0000-4000-8000-000000000101'
FROM
  (
    VALUES
      (
        '00000000-0000-4000-8000-000000000101'::uuid,
        'platform_admin'
      ),
      (
        '00000000-0000-4000-8000-000000000102'::uuid,
        'support_agent'
      ),
      (
        '00000000-0000-4000-8000-000000000103'::uuid,
        'ops_viewer'
      ),
      (
        '00000000-0000-4000-8000-000000000104'::uuid,
        'sales_ops'
      ),
      (
        '00000000-0000-4000-8000-000000000105'::uuid,
        'finance_ops'
      )
  ) AS seed (operator_id, role_code)
  JOIN ops.roles AS role ON role.code = seed.role_code;


-- 一条已存在的审计记录：没有它，「读不到审计」的断言会因为表是空的而恒真，
-- 那种绿色证明不了策略在起作用。
INSERT INTO
  ops.audit_events (
    id,
    actor_operator_id,
    actor_user_id,
    action,
    entity_type,
    reason
  )
VALUES
  (
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-0000000000a1',
    'fixture.seed',
    'operator',
    '夹具'
  );


-- ── P1 / §7.2：schema 层的拒绝边界 ──────────────────────────────────────────
SELECT
  IS (
    has_schema_privilege('anon', 'ops', 'USAGE'),
    FALSE,
    'P1: anon has no USAGE on the ops schema'
  );


SELECT
  IS (
    has_schema_privilege('authenticated', 'ops', 'USAGE'),
    TRUE,
    'authenticated does have USAGE, so denials below come from policies rather than grants'
  );


-- ── P2：租户成员（无 ops.operators 行）看不到任何 ops 数据 ───────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.current_operator_id ()
    ),
    NULL,
    'P2: a tenant member resolves to no operator'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.operators
    ),
    0,
    'P2: a tenant member reads zero operator rows'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.roles
    ),
    0,
    'P2: a tenant member reads zero role rows'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.get_current_ops_context ()
    ),
    0,
    'P2: a tenant member gets an empty ops context'
  );


RESET ROLE;


-- ── P4：invited / disabled 与 active 的差别 ─────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.current_operator_id ()
    ),
    NULL,
    'P4: an invited operator resolves to no operator'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.operators
    ),
    0,
    'P4: an invited operator reads zero operator rows'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.current_operator_id ()
    ),
    NULL,
    'P4: a disabled operator resolves to no operator'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.operators
    ),
    0,
    'P4: a disabled operator reads zero operator rows'
  );


RESET ROLE;


-- ── 允许路径：active 运营成员拿到完整上下文 ──────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.get_current_ops_context ()
    ),
    1,
    'an active operator gets exactly one context row'
  );


SELECT
  IS (
    (
      SELECT
        role_codes
      FROM
        ops.get_current_ops_context ()
    ),
    ARRAY['support_agent']::TEXT[],
    'the context carries the role codes'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        unnest(
          (
            SELECT
              permission_codes
            FROM
              ops.get_current_ops_context ()
          )
        ) AS permission_code
      WHERE
        permission_code LIKE 'receivable.%'
    ),
    0,
    'support_agent holds no receivable permission (contract section 4)'
  );


-- ── 权限并集与动作码判定 ───────────────────────────────────────────────────
SELECT
  ok (
    ops.has_permission ('ticket.read'),
    'support_agent can read tickets'
  );


SELECT
  IS (
    ops.has_permission ('receivable.read'),
    FALSE,
    'support_agent cannot read receivables'
  );


SELECT
  IS (
    ops.has_permission ('customer.sensitive.read'),
    FALSE,
    'support_agent cannot read contact originals'
  );


-- 审计表里已有一条记录（夹具）。没有 audit.read 的角色必须一行都读不到；
-- 若策略只写「是运营成员」而不判动作码，这条会变成 1 而红。
SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.audit_events
    ),
    0,
    'support_agent without audit.read reads zero audit rows'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.operators
    ),
    5,
    'platform_admin with operator.read reads every operator row'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.audit_events
    ),
    1,
    'platform_admin with audit.read reads the audit trail'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  ok (
    ops.has_permission ('customer.read'),
    'ops_viewer can read customers'
  );


SELECT
  IS (
    ops.has_permission ('customer.write'),
    FALSE,
    'ops_viewer holds no write permission'
  );


RESET ROLE;


-- 多角色取并集：给只读账号再挂一个售后角色，合起来才有 audit.read 以外的并集效果。
INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000103',
  role.id,
  '00000000-0000-4000-8000-000000000101'
FROM
  ops.roles AS role
WHERE
  role.code = 'support_agent';


SET
  local role authenticated;


SELECT
  ok (
    ops.has_permission ('ticket.assign'),
    'permissions from multiple roles are unioned'
  );


RESET ROLE;


-- ── 39 码与 6 角色的 seed 对账（契约 §4） ──────────────────────────────────
SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.permissions
    ),
    39,
    'the permission catalogue seeds exactly 39 action codes'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.permissions
      WHERE
        is_high_risk
    ),
    14,
    '14 of them are high risk'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.roles
      WHERE
        is_system
    ),
    6,
    'six preset roles are seeded as system roles'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.role_permissions AS role_permission
        JOIN ops.roles AS role ON role.id = role_permission.role_id
      WHERE
        role.code = 'platform_admin'
    ),
    39,
    'platform_admin maps to every action code rather than bypassing the check'
  );


-- ── 函数形态：search_path 与 EXECUTE 授权 ──────────────────────────────────
SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE
        namespace.nspname = 'ops'
        AND procedure.proname IN (
          'current_operator_id',
          'has_permission',
          'get_current_ops_context',
          'require_permission',
          'write_audit'
        )
        AND procedure.proconfig @> ARRAY['search_path=""']
    ),
    5,
    'every ops helper pins search_path to the empty string'
  );


SELECT
  IS (
    has_function_privilege('anon', 'ops.current_operator_id()', 'EXECUTE'),
    FALSE,
    'anon cannot execute the operator resolver'
  );


SELECT
  IS (
    has_function_privilege(
      'anon',
      'ops.get_current_ops_context()',
      'EXECUTE'
    ),
    FALSE,
    'anon cannot execute the session context reader'
  );


-- ── 写路径：只有 SELECT 授权，写入必须经 RPC ────────────────────────────────
SELECT
  IS (
    has_table_privilege('authenticated', 'ops.operators', 'INSERT'),
    FALSE,
    'authenticated cannot insert operators directly'
  );


SET
  local role authenticated;


-- 这条必须真的以 authenticated 身份执行：以属主身份跑，UPDATE 会成功，
-- 断言的绿色就变成了「我们能改审计」的假证据。
SELECT
  throws_ok (
    $$ update ops.audit_events set action = 'tampered' $$,
    '42501',
    NULL,
    'P7: audit events cannot be rewritten'
  );


RESET ROLE;


SELECT
  IS (
    (
      SELECT
        permission_version
      FROM
        ops.operators
      WHERE
        id = '00000000-0000-4000-8000-000000000102'
    ),
    1::bigint,
    'permission_version starts at one'
  );


-- ── write_audit：actor 两列从会话推导，不接受传入 ───────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  isnt (
    ops.write_audit (
      'operator.self_check',
      'operator',
      '00000000-0000-4000-8000-000000000102',
      '测试写入'
    ),
    NULL,
    'an active operator can append an audit event'
  );


RESET ROLE;


SELECT
  IS (
    (
      SELECT
        actor_operator_id::text || '|' || actor_user_id::text
      FROM
        ops.audit_events
      WHERE
        action = 'operator.self_check'
    ),
    '00000000-0000-4000-8000-000000000102|00000000-0000-4000-8000-0000000000a2',
    'the audit row records both the operator key and the auth user id'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;