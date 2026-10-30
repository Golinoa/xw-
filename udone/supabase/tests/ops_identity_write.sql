BEGIN;


SELECT
  plan (48);


-- 夹具：五个 auth 用户。两个有效运营账号（平台管理员 / 只读），一个没有运营行
-- （租户成员），一个待邀请对象，一个用来验证停用路径。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000d1',
    'authenticated',
    'authenticated',
    'write-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000d2',
    'authenticated',
    'authenticated',
    'write-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000d3',
    'authenticated',
    'authenticated',
    'write-tenant@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000d4',
    'authenticated',
    'authenticated',
    'write-invitee@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000d5',
    'authenticated',
    'authenticated',
    'write-disabled@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000301',
    '00000000-0000-4000-8000-0000000000d1',
    'write-admin@example.test',
    '写侧管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000302',
    '00000000-0000-4000-8000-0000000000d2',
    'write-viewer@example.test',
    '只读观察者',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000303',
    '00000000-0000-4000-8000-0000000000d5',
    'write-disabled@example.test',
    '待停用账号',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000301',
  role.id,
  '00000000-0000-4000-8000-000000000301'
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000302',
  role.id,
  '00000000-0000-4000-8000-000000000301'
FROM
  ops.roles AS role
WHERE
  role.code = 'ops_viewer';


-- ── 能力面：匿名一行都不给，形状函数不给任何非属主角色 ─────────────────────
SELECT
  ok (
    NOT has_function_privilege(
      'anon',
      'ops.list_operators(text,text,text,text,text,integer,integer)',
      'EXECUTE'
    ),
    'anon cannot list operators'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'anon',
      'ops.invite_operator(uuid,text,text[],text,text,text)',
      'EXECUTE'
    ),
    'anon cannot invite operators'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'anon',
      'ops.update_operator(uuid,integer,text,text[],boolean,text,text,text)',
      'EXECUTE'
    ),
    'anon cannot update operators'
  );


-- 形状函数不带权限判定。若它被 granted 给 authenticated，任何登录用户都能
-- `rpc/operator_json` 拿到全量运营账号——这条断言防的正是「顺手授一下」。
SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.operator_json(uuid)',
      'EXECUTE'
    ),
    'the operator shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege('authenticated', 'ops.role_json(uuid)', 'EXECUTE'),
    'the role shape helper is not callable by authenticated'
  );


-- ── 无运营身份：连函数都进不去 ──────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000d3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select ops.list_operators()',
    '42501',
    NULL,
    'a tenant member without an operator row cannot list operators'
  );


SELECT
  throws_ok (
    'select ops.list_audit_events()',
    '42501',
    NULL,
    'a tenant member without an operator row cannot read audit events'
  );


RESET ROLE;


-- ── 只读角色：能读审计，不能读账号 ──────────────────────────────────────────
-- `ops_viewer` 的权限清单里没有 `operator.read`，但**有** `audit.read`。
-- 这一对断言证明权限判定是按动作码，而不是按「是不是运营成员」。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000d2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select ops.list_operators()',
    '42501',
    NULL,
    'a viewer without operator.read cannot list operators'
  );


SELECT
  IS (
    jsonb_typeof(ops.list_audit_events () -> 'items'),
    'array',
    'a viewer with audit.read can read the audit trail'
  );


RESET ROLE;


-- ── 管理员视角 ──────────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- U-18：`PATCH /operators/{id}` 的乐观锁值来自列表，列表项因此必须带 version；
-- `mfaRequired` 同源。缺任一项，运营端的成员编辑只能禁用。
SELECT
  ok (
    (ops.list_operators () -> 'items' -> 0) ? 'version',
    'the operator list carries the optimistic-lock version (U-18)'
  );


SELECT
  ok (
    (ops.list_operators () -> 'items' -> 0) ? 'mfa_required',
    'the operator list carries mfa_required (U-18)'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_operators (p_status => 'active') -> 'items'
    ),
    3,
    'the status filter narrows the list to active accounts'
  );


SELECT
  IS (
    ops.invite_operator (
      '00000000-0000-4000-8000-0000000000d4',
      'write-invitee@example.test',
      ARRAY['platform_admin'],
      ''
    ) ->> 'status',
    'reason_required',
    'an invitation without a reason is refused inside the database too'
  );


SELECT
  IS (
    ops.invite_operator (
      '00000000-0000-4000-8000-0000000000d4',
      'write-invitee@example.test',
      ARRAY[]::TEXT[],
      '批量邀请'
    ) ->> 'status',
    'roles_required',
    'an invitation without roles is refused'
  );


SELECT
  IS (
    ops.invite_operator (
      '00000000-0000-4000-8000-0000000000d4',
      'write-invitee@example.test',
      ARRAY['no_such_role'],
      '批量邀请'
    ) ->> 'status',
    'unknown_role',
    'an unknown role code is reported instead of silently dropped'
  );


SELECT
  IS (
    ops.invite_operator (
      '00000000-0000-4000-8000-0000000000d4',
      'write-invitee@example.test',
      ARRAY['finance_ops'],
      '新同事入职'
    ) ->> 'status',
    'ok',
    'a valid invitation is accepted'
  );


SELECT
  IS (
    (
      SELECT
        operator.status
      FROM
        ops.operators AS operator
      WHERE
        operator.email = 'write-invitee@example.test'
    ),
    'invited',
    'the invited account starts as invited, not active'
  );


-- 邮箱统一小写存：GoTrue 返回的大小写与邀请时输入的未必一致，按原值存会放过
-- 「Alice@x.com」与「alice@x.com」两个账号。
SELECT
  IS (
    (
      SELECT
        operator.email
      FROM
        ops.operators AS operator
      WHERE
        operator.status = 'invited'
    ),
    'write-invitee@example.test',
    'the invited email is stored lower-cased'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'operator.invited'
        AND event.reason = '新同事入职'
        AND event.actor_operator_id = '00000000-0000-4000-8000-000000000301'
    ),
    1::bigint,
    'the invitation writes an audit event with the acting operator'
  );


SELECT
  IS (
    ops.invite_operator (
      '00000000-0000-4000-8000-0000000000d4',
      'write-invitee@example.test',
      ARRAY['finance_ops'],
      '重复邀请'
    ) ->> 'status',
    'email_exists',
    'inviting an existing email is reported as a conflict'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.operators AS operator
      WHERE
        operator.email = 'write-invitee@example.test'
    ),
    1::bigint,
    'a refused invitation does not create a second row'
  );


-- ── 乐观锁 ──────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.update_operator (
      '00000000-0000-4000-8000-000000000303',
      99,
      'disabled',
      NULL,
      NULL,
      '版本过期'
    ) ->> 'status',
    'version_mismatch',
    'a stale version is refused'
  );


SELECT
  IS (
    (
      SELECT
        operator.version
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000303'
    ),
    1,
    'a refused update leaves the version untouched'
  );


-- ── 两条自锁不变量 ─────────────────────────────────────────────────────────
SELECT
  IS (
    ops.update_operator (
      '00000000-0000-4000-8000-000000000302',
      1,
      NULL,
      ARRAY[]::TEXT[],
      NULL,
      '清空角色'
    ) ->> 'status',
    'last_role',
    'removing the last role is refused'
  );


SELECT
  IS (
    ops.update_operator (
      '00000000-0000-4000-8000-000000000301',
      1,
      'disabled',
      NULL,
      NULL,
      '停用最后一个管理员'
    ) ->> 'status',
    'last_admin',
    'disabling the last operator with operator.manage is refused'
  );


SELECT
  IS (
    ops.update_operator (
      '00000000-0000-4000-8000-000000000301',
      1,
      NULL,
      ARRAY['ops_viewer'],
      NULL,
      '把自己降级'
    ) ->> 'status',
    'last_admin',
    'demoting the last operator with operator.manage is refused'
  );


SELECT
  IS (
    (
      SELECT
        operator.status
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000301'
    ),
    'active',
    'a refused self-demotion leaves the account active'
  );


-- ── 正常改角色：权限差集、版本自增、审计摘要 ───────────────────────────────
SELECT
  ok (
    (
      ops.update_operator (
        '00000000-0000-4000-8000-000000000302',
        1,
        NULL,
        ARRAY['finance_ops'],
        NULL,
        '转岗到财务'
      ) #> '{permissions_changed,added}'
    ) @> '["receipt.approve"]'::jsonb,
    'the response carries the permissions gained by the role change'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.update_operator (
        '00000000-0000-4000-8000-000000000302',
        2,
        NULL,
        ARRAY['finance_ops'],
        TRUE,
        '补 MFA'
      ) #> '{permissions_changed,removed}'
    ),
    0,
    're-sending the same roles removes no permission'
  );


SELECT
  IS (
    (
      SELECT
        operator.permission_version
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000302'
    ),
    2::bigint,
    'a role change bumps permission_version exactly once'
  );


SELECT
  IS (
    (
      SELECT
        event.before_summary #> '{permissions}'
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'operator.updated'
        AND event.entity_id = '00000000-0000-4000-8000-000000000302'
        AND event.reason = '转岗到财务'
    ) ? 'customer.read',
    TRUE,
    'the audit event records the permissions held before the change'
  );


-- ── 停用：时间与原因落库，重新启用时清空 ───────────────────────────────────
SELECT
  IS (
    ops.update_operator (
      '00000000-0000-4000-8000-000000000303',
      1,
      'disabled',
      NULL,
      NULL,
      '离职'
    ) ->> 'status',
    'ok',
    'disabling a non-admin account is allowed'
  );


SELECT
  ok (
    (
      SELECT
        operator.disabled_at IS NOT NULL
        AND operator.disabled_reason = '离职'
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000303'
    ),
    'disabling records both the timestamp and the reason'
  );


SELECT
  IS (
    ops.update_operator (
      '00000000-0000-4000-8000-000000000303',
      2,
      'active',
      NULL,
      NULL,
      '复职'
    ) ->> 'status',
    'ok',
    're-activating a disabled account is allowed'
  );


SELECT
  ok (
    (
      SELECT
        operator.disabled_at IS NULL
        AND operator.disabled_reason IS NULL
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000303'
    ),
    're-activating clears the disabled timestamp and reason'
  );


-- ── 角色写侧 ────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.create_role (
      'platform_admin',
      '重复',
      '',
      ARRAY['customer.read'],
      '重复 code'
    ) ->> 'status',
    'role_code_exists',
    'a duplicate role code is refused'
  );


SELECT
  IS (
    ops.create_role (
      'auditor',
      '审计员',
      '只读审计',
      ARRAY['no.such.permission'],
      '建角色'
    ) ->> 'status',
    'unknown_permission',
    'an unknown permission code is refused'
  );


SELECT
  IS (
    ops.create_role (
      'auditor',
      '审计员',
      '只读审计',
      ARRAY['audit.read', 'overview.read'],
      '建角色'
    ) ->> 'status',
    'ok',
    'a valid custom role is created'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'role.created'
    ),
    1::bigint,
    'creating a role writes an audit event'
  );


-- 系统角色的 code 不可改：`update_role` 的签名里没有这个参数。这条断言防的是
-- 「以后为了让某个页面方便，顺手加一个 p_code」——那会让 seed 出来的角色码漂移，
-- 而平台管理员拿满 39 个码靠的正是 code。
SELECT
  ok (
    NOT EXISTS (
      SELECT
        1
      FROM
        pg_proc AS procedure,
        unnest(procedure.proargnames) AS argument_name
      WHERE
        procedure.oid = 'ops.update_role(uuid,text,text,text[],text,text,text)'::regprocedure
        AND argument_name IN ('code', 'p_code')
    ),
    'update_role has no parameter that could rename a role code'
  );


SELECT
  IS (
    ops.update_role (
      (
        SELECT
          role.id
        FROM
          ops.roles AS role
        WHERE
          role.code = 'platform_admin'
      ),
      NULL,
      NULL,
      ARRAY['customer.read'],
      NULL,
      '把平台管理员削成只剩一个码'
    ) ->> 'status',
    'last_admin',
    'stripping operator.manage from the only granting role is refused'
  );


SELECT
  IS (
    ops.update_role (
      (
        SELECT
          role.id
        FROM
          ops.roles AS role
        WHERE
          role.code = 'auditor'
      ),
      NULL,
      NULL,
      ARRAY['audit.read'],
      NULL,
      '收紧审计员权限'
    ) #> '{before_permissions}',
    '["audit.read", "overview.read"]'::jsonb,
    'the response carries the permission set held before the edit'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'role.permissions_changed'
        AND event.entity_id = (
          SELECT
            role.id
          FROM
            ops.roles AS role
          WHERE
            role.code = 'auditor'
        )
    ),
    1::bigint,
    'a permission edit is recorded under its own action'
  );


-- 角色权限变更要把持有者的 permission_version 推一格，否则被改的人要等到下次
-- 登录才看见菜单变化，而那期间他会看到「按钮在、点了 403」。
SELECT
  IS (
    ops.update_role (
      (
        SELECT
          role.id
        FROM
          ops.roles AS role
        WHERE
          role.code = 'finance_ops'
      ),
      NULL,
      NULL,
      ARRAY(
        SELECT
          role_permission.permission_code
        FROM
          ops.role_permissions AS role_permission
          JOIN ops.roles AS role ON role.id = role_permission.role_id
        WHERE
          role.code = 'finance_ops'
        UNION
        SELECT
          'catalog.read'
      ),
      NULL,
      '财务也能看目录'
    ) ->> 'status',
    'ok',
    'editing a system role permission set is allowed'
  );


SELECT
  IS (
    (
      SELECT
        operator.permission_version
      FROM
        ops.operators AS operator
      WHERE
        operator.id = '00000000-0000-4000-8000-000000000302'
    ),
    3::bigint,
    'editing a role bumps the version of every holder'
  );


RESET ROLE;


-- ── 审计查询 ────────────────────────────────────────────────────────────────
-- service_role 与定时任务写入的事件没有 actor 两列。内连接会把它们整行吞掉，
-- 而恰恰是这些行最需要被看见，所以 actor 必须可空。
INSERT INTO
  ops.audit_events (action, entity_type, reason)
VALUES
  ('system.cleanup', 'system', '定时清理');


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        event ->> 'action'
      FROM
        jsonb_array_elements(
          ops.list_audit_events (p_action => 'system.cleanup') -> 'items'
        ) AS event
      LIMIT
        1
    ),
    'system.cleanup',
    'the action filter returns only matching events'
  );


SELECT
  IS (
    (
      SELECT
        event -> 'actor'
      FROM
        jsonb_array_elements(
          ops.list_audit_events (p_action => 'system.cleanup') -> 'items'
        ) AS event
      LIMIT
        1
    ),
    'null'::jsonb,
    'an event without an actor keeps a null actor instead of disappearing'
  );


SELECT
  IS (
    (
      SELECT
        event #>> '{actor,display_name}'
      FROM
        jsonb_array_elements(
          ops.list_audit_events (p_action => 'operator.invited') -> 'items'
        ) AS event
      LIMIT
        1
    ),
    '写侧管理员',
    'the audit list resolves the actor display name in one query'
  );


RESET ROLE;


SELECT
  *
FROM
  finish ();


ROLLBACK;