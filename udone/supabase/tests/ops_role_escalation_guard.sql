BEGIN;


SELECT
  plan (4);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- A 是「能管角色、能管账号，但不是全权」的那个人：这正是审计点名的场景——
-- 只要 `role.manage` + `operator.manage`，就能建全权角色再分给自己。
--
-- 下面这几条写表语句刻意**不** SET ROLE：它们代表迁移/种子路径，
-- 防护必须放行，否则部署流程会被自己的守卫锁死。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000e1',
    'authenticated',
    'authenticated',
    'scope-manager@example.test'
  );

INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000e01',
    '00000000-0000-4000-8000-0000000000e1',
    'scope-manager@example.test',
    '范围受限的管理员',
    'active'
  );

INSERT INTO
  ops.roles (id, code, name, is_system)
VALUES
  (
    '00000000-0000-4000-8000-000000000f01',
    'scope_manager',
    '范围受限管理员',
    false
  );

INSERT INTO
  ops.role_permissions (role_id, permission_code)
VALUES
  ('00000000-0000-4000-8000-000000000f01', 'role.manage'),
  ('00000000-0000-4000-8000-000000000f01', 'operator.manage');

INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
VALUES
  (
    '00000000-0000-4000-8000-000000000e01',
    '00000000-0000-4000-8000-000000000f01',
    '00000000-0000-4000-8000-000000000e01'
  );

-- 种子路径不被拦：没有任何 SET ROLE 的会话，守卫应该当它不存在。
SELECT
  is(
    (
      SELECT
        count(*)::integer
      FROM
        ops.role_permissions
      WHERE
        role_id = '00000000-0000-4000-8000-000000000f01'
    ),
    2,
    '无 SET ROLE 的会话（迁移/种子）写入不受权限范围限制'
  );


-- ── 以 A 的身份走 RPC ────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}',
    TRUE
  );

SET LOCAL ROLE authenticated;


-- 想建一个「带 operator.read」的角色：A 自己没有 operator.read，必须被拒。
SELECT
  throws_ok(
    $$ select ops.create_role(
         'escalated_role',
         '提权角色',
         null,
         array['role.manage', 'operator.read'],
         '测试提权'
       ) $$,
    '42501',
    NULL,
    '不能给自己没有的权限建角色'
  );


-- 子集可以建：这是正常的「把已有能力打包成角色」。
SELECT
  is(
    ops.create_role (
      'scope_subset_role',
      '子集角色',
      null,
      array['role.manage'],
      '打包已有权限'
    ) ->> 'status',
    'ok',
    '授予集合 ⊆ 自己已有权限时可以建角色'
  );


-- 一通尝试之后，A 手上的权限没有变多：仍只有那两条。
SELECT
  is(
    (
      SELECT
        array(
          SELECT
            unnest(context.permission_codes)
          ORDER BY
            1
        )
      FROM
        ops.get_current_ops_context() AS context
    ),
    array['operator.manage', 'role.manage'],
    '反复尝试后权限集合没有扩大（仍是 role.manage + operator.manage）'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
