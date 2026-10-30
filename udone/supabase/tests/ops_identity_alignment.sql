BEGIN;


SELECT
  plan (37);


-- 夹具：五个身份覆盖「激活 / 不激活」的四条分支，两个邀请对象，一个管理员。
-- 「有行但 invited」「有行但 disabled」「没有行」必须是三个不同的账号——合成
-- 一个就分不出「状态不对」与「根本没有运营行」，而那正是两个返回词的区别。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000e1',
    'authenticated',
    'authenticated',
    'alignment-invited@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e2',
    'authenticated',
    'authenticated',
    'alignment-touch@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e3',
    'authenticated',
    'authenticated',
    'alignment-disabled@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e4',
    'authenticated',
    'authenticated',
    'alignment-tenant@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e5',
    'authenticated',
    'authenticated',
    'alignment-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e6',
    'authenticated',
    'authenticated',
    'alignment-named@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e7',
    'authenticated',
    'authenticated',
    'alignment-blank@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000501',
    '00000000-0000-4000-8000-0000000000e5',
    'alignment-admin@example.test',
    '对齐管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000502',
    '00000000-0000-4000-8000-0000000000e1',
    'alignment-invited@example.test',
    '待激活',
    'invited'
  ),
  (
    '00000000-0000-4000-8000-000000000503',
    '00000000-0000-4000-8000-0000000000e2',
    'alignment-touch@example.test',
    '不该被写登录时间',
    'invited'
  ),
  (
    '00000000-0000-4000-8000-000000000504',
    '00000000-0000-4000-8000-0000000000e3',
    'alignment-disabled@example.test',
    '已停用',
    'disabled'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000501',
  role.id,
  '00000000-0000-4000-8000-000000000501'
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


-- ── 能力面 ──────────────────────────────────────────────────────────────────
-- 两个新函数都在登录链路上，而登录端点是匿名可达的第一个入口：给它任何库内
-- 能力都等于把「激活/写时间」交给未登录的人。
SELECT
  ok (
    NOT has_function_privilege(
      'anon',
      'ops.activate_invited_member()',
      'EXECUTE'
    ),
    'anon cannot activate an invited operator'
  );


SELECT
  ok (
    NOT has_function_privilege('anon', 'ops.touch_last_login()', 'EXECUTE'),
    'anon cannot write last_login_at'
  );


-- ── invited → active（D-01）──────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.activate_invited_member ()
    ),
    'activated',
    'an invited account is activated by its own token'
  );


-- 读表要换回属主身份：RLS 对「没有 operator.read 的账号」返回零行，用被激活的
-- 账号自己 `select status` 只会拿到 NULL，看起来像「状态没变」——而 NULL 恰恰
-- 说明策略是生效的。断言状态与断言函数返回值要分成两种身份做。
RESET ROLE;


SELECT
  IS (
    (
      SELECT
        operator.status
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000502'
    ),
    'active',
    'activation flips the stored status to active'
  );


-- version 要涨：账号状态变了，管理员手里那份乐观锁值就该失效一次，否则他会在
-- 一个已经变成 active 的行上做「启用」而看不出来变了什么。
SELECT
  IS (
    (
      SELECT
        operator.version
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000502'
    ),
    2,
    'activation bumps the optimistic-lock version exactly once'
  );


-- ── 重复调用幂等 ────────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.activate_invited_member ()
    ),
    'unchanged',
    'a second activation reports unchanged instead of rewriting the row'
  );


RESET ROLE;


SELECT
  IS (
    (
      SELECT
        operator.version
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000502'
    ),
    2,
    'a repeated activation does not bump the version again'
  );


RESET ROLE;


-- ── disabled 不复活 ────────────────────────────────────────────────────────
-- 停用是管理员做的决定。一次登录能把它改回来，等于「被停用的人只要一直重试
-- 就能自己解封」。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.activate_invited_member ()
    ),
    'unchanged',
    'a disabled account is not reactivated by signing in'
  );


RESET ROLE;


SELECT
  IS (
    (
      SELECT
        operator.status
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000504'
    ),
    'disabled',
    'a disabled account stays disabled after the activation attempt'
  );


RESET ROLE;


-- ── 没有运营行 ──────────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.activate_invited_member ()
    ),
    'missing',
    'a tenant member with no operator row resolves to missing'
  );


RESET ROLE;


-- ── last_login_at 只写 active 行（D-05）─────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.touch_last_login ()
    ),
    'ok',
    'the login timestamp is written for an active account'
  );


RESET ROLE;


SELECT
  ok (
    (
      SELECT
        operator.last_login_at IS NOT NULL
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000502'
    ),
    'an active account gets a non-null last_login_at'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.touch_last_login ()
    ),
    'missing',
    'an invited account is not an active row, so nothing is written'
  );


RESET ROLE;


SELECT
  ok (
    (
      SELECT
        operator.last_login_at IS NULL
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000503'
    ),
    'an invited account keeps a null last_login_at'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.touch_last_login ()
    ),
    'missing',
    'a disabled account does not get a login timestamp'
  );


RESET ROLE;


SELECT
  ok (
    (
      SELECT
        operator.last_login_at IS NULL
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000504'
    ),
    'a disabled account keeps a null last_login_at'
  );


RESET ROLE;


-- ── 写权限没有因为本次迁移而放宽 ────────────────────────────────────────────
-- D-01/D-02 都是写路径，最容易顺手「授一下 INSERT/UPDATE」。这两条断言就是
-- 那个顺手的守门人：写侧仍然只有 SECURITY DEFINER RPC。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'insert into ops.operators (user_id, email) values (''00000000-0000-4000-8000-0000000000e7'', ''alignment-blank@example.test'')',
    '42501',
    NULL,
    'authenticated still cannot insert an operator row directly'
  );


SELECT
  throws_ok (
    'update ops.operators set status = ''active'' where id = ''00000000-0000-4000-8000-000000000503''',
    '42501',
    NULL,
    'authenticated still cannot update an operator row directly'
  );


RESET ROLE;


-- ── invite_operator 写 display_name（D-02）──────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e5","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.invite_operator (
      '00000000-0000-4000-8000-0000000000e6',
      'alignment-named@example.test',
      ARRAY['ops_viewer'],
      '邀请带姓名',
      p_display_name => '  张三  '
    ) ->> 'status',
    'ok',
    'an invitation carrying a display name is accepted'
  );


SELECT
  IS (
    (
      SELECT
        operator.display_name
      FROM
        ops.operators AS operator
      WHERE
        operator.email = 'alignment-named@example.test'
    ),
    '张三',
    'the display name is trimmed on the way in'
  );


SELECT
  IS (
    ops.invite_operator (
      '00000000-0000-4000-8000-0000000000e7',
      'alignment-blank@example.test',
      ARRAY['ops_viewer'],
      '邀请不填姓名',
      p_display_name => ''
    ) ->> 'status',
    'ok',
    'an invitation with an empty display name is accepted'
  );


-- 空串要落 NULL 而不是空字符串：列表按它排序时，空串会占一个确定的位置。
SELECT
  ok (
    (
      SELECT
        operator.display_name IS NULL
      FROM
        ops.operators AS operator
      WHERE
        operator.email = 'alignment-blank@example.test'
    ),
    'an empty display name is stored as NULL, not as an empty string'
  );


-- ── update_operator 改 / 清空 display_name（D-02）──────────────────────────
SELECT
  IS (
    ops.update_operator (
      (
        SELECT
          operator.id
        FROM
          ops.operators AS operator
        WHERE
          operator.email = 'alignment-named@example.test'
      ),
      1,
      NULL,
      NULL,
      NULL,
      '补录姓名',
      p_display_name => '李四'
    ) ->> 'status',
    'ok',
    'PATCH can change the display name'
  );


SELECT
  IS (
    (
      SELECT
        operator.display_name
      FROM
        ops.operators AS operator
      WHERE
        operator.email = 'alignment-named@example.test'
    ),
    '李四',
    'the new display name is stored'
  );


-- 只传空白 = 清空。这里不能是「不改」：`NULL` 已经在别处表示「不改」，
-- 若空白也走那条路，界面上把名字删空再保存会毫无反应。
SELECT
  IS (
    ops.update_operator (
      (
        SELECT
          operator.id
        FROM
          ops.operators AS operator
        WHERE
          operator.email = 'alignment-named@example.test'
      ),
      2,
      NULL,
      NULL,
      NULL,
      '清空姓名',
      p_display_name => '   '
    ) ->> 'status',
    'ok',
    'a whitespace-only display name clears the column'
  );


SELECT
  ok (
    (
      SELECT
        operator.display_name IS NULL
      FROM
        ops.operators AS operator
      WHERE
        operator.email = 'alignment-named@example.test'
    ),
    'clearing the display name stores NULL'
  );


SELECT
  IS (
    ops.update_operator (
      (
        SELECT
          operator.id
        FROM
          ops.operators AS operator
        WHERE
          operator.email = 'alignment-named@example.test'
      ),
      3,
      NULL,
      NULL,
      NULL,
      '再补姓名',
      p_display_name => '王五'
    ) ->> 'status',
    'ok',
    'the display name can be set again after being cleared'
  );


-- 加参数不该动乐观锁语义：版本对不上仍然先返回 version_mismatch，且不写审计。
SELECT
  IS (
    ops.update_operator (
      (
        SELECT
          operator.id
        FROM
          ops.operators AS operator
        WHERE
          operator.email = 'alignment-named@example.test'
      ),
      2,
      NULL,
      NULL,
      NULL,
      '版本过期',
      p_display_name => '赵六'
    ) ->> 'status',
    'version_mismatch',
    'a stale version is still refused after adding the display-name argument'
  );


-- 审计摘要要带上显示名：改了却看不见，等于这次改动不可追溯。
SELECT
  ok (
    (
      SELECT
        event.after_summary ? 'displayName'
        AND event.after_summary ->> 'displayName' = '王五'
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'operator.updated'
        AND event.reason = '再补姓名'
    ),
    'the update audit summary records the display name after the change'
  );


-- ── 五个审计动作词都能按 p_action 筛到（D-03）──────────────────────────────
SELECT
  IS (
    ops.create_role (
      'alignment_auditor',
      '对齐审计员',
      '',
      ARRAY['audit.read'],
      '建角色'
    ) ->> 'status',
    'ok',
    'a role is created so the role.created word has a producer'
  );


-- 只改名、不动权限：落 role.updated。
SELECT
  IS (
    ops.update_role (
      (
        SELECT
          role.id
        FROM
          ops.roles AS role
        WHERE
          role.code = 'alignment_auditor'
      ),
      '对齐审计员（改名）',
      NULL,
      NULL,
      NULL,
      '改角色名'
    ) ->> 'status',
    'ok',
    'renaming a role is accepted'
  );


-- 动权限：落 role.permissions_changed，不再落 role.updated。
SELECT
  IS (
    ops.update_role (
      (
        SELECT
          role.id
        FROM
          ops.roles AS role
        WHERE
          role.code = 'alignment_auditor'
      ),
      NULL,
      NULL,
      ARRAY['audit.read', 'overview.read'],
      NULL,
      '加权限'
    ) ->> 'status',
    'ok',
    'changing a permission set is accepted'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_audit_events (p_action => 'operator.invited') -> 'items'
    ),
    2,
    'operator.invited is selectable through the action filter'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_audit_events (p_action => 'operator.updated') -> 'items'
    ),
    3,
    'operator.updated is selectable through the action filter'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_audit_events (p_action => 'role.created') -> 'items'
    ),
    1,
    'role.created is selectable through the action filter'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_audit_events (p_action => 'role.updated') -> 'items'
    ),
    1,
    'role.updated is selectable through the action filter'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_audit_events (p_action => 'role.permissions_changed') -> 'items'
    ),
    1,
    'role.permissions_changed is selectable through the action filter'
  );


RESET ROLE;


SELECT
  *
FROM
  finish ();


ROLLBACK;