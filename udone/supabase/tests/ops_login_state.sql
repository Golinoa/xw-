BEGIN;


SELECT
  plan (6);


-- 夹具只建这一条链路需要的东西：三个有运营账号的 auth 用户（active/invited/disabled），
-- 一个只有租户身份的（用来证明「没有运营行」与「有行但停用」不是同一件事）。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000c1',
    'authenticated',
    'authenticated',
    'login-active@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000c2',
    'authenticated',
    'authenticated',
    'login-invited@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000c3',
    'authenticated',
    'authenticated',
    'login-disabled@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000c4',
    'authenticated',
    'authenticated',
    'login-tenant@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-0000000000c1',
    'login-active@example.test',
    '在线运营',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-0000000000c2',
    'login-invited@example.test',
    '待接受邀请',
    'invited'
  ),
  (
    '00000000-0000-4000-8000-000000000203',
    '00000000-0000-4000-8000-0000000000c3',
    'login-disabled@example.test',
    '已停用',
    'disabled'
  );


-- 未登录连函数都调不到：这是 P1 的延伸，登录端点是匿名可访问的第一个入口，
-- 不能因此给 anon 任何库内能力。
SELECT
  IS (
    has_function_privilege('anon', 'ops.login_member_state()', 'EXECUTE'),
    FALSE,
    'anon cannot execute the login state reader'
  );


-- active：唯一会继续下去的分支
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.login_member_state ()
    ),
    'active',
    'an active operator resolves to active'
  );


RESET ROLE;


-- invited：账号已建但没接受邀请。契约只有 MISSING / INACTIVE 两个原因，
-- 这里返回 invited 而不是提前合并，是为了让「合并发生在哪一层」有据可查
-- （合并由 Worker 的 memberReasonFor 做，测试能看见原始状态）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000c2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.login_member_state ()
    ),
    'invited',
    'an invited operator is reported as invited, not as a member'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000c3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.login_member_state ()
    ),
    'disabled',
    'a disabled operator is reported as disabled'
  );


RESET ROLE;


-- 租户成员：令牌有效、auth.uid() 有值，但没有 ops.operators 行。
-- 这条与上一条必须分开断言：合成一条就分不出「没账号」与「被停用」，
-- 而那正是契约要求 403 带两个不同 reason 的原因。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000c4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.login_member_state ()
    ),
    'missing',
    'a tenant member with no operator row resolves to missing'
  );


RESET ROLE;


-- 属主身份、没有任何 claims：auth.uid() 为空。service_role 走请求路径时就是
-- 这个形态，它必须拿到 missing，而不是「因为权限大所以是成员」。
SELECT
  set_config('request.jwt.claims', '', TRUE);


SELECT
  IS (
    (
      SELECT
        ops.login_member_state ()
    ),
    'missing',
    'an identity-less caller (service role, owner) resolves to missing'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;