BEGIN;


SELECT
  plan (5);


INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000f1',
    'authenticated',
    'authenticated',
    'access-audit@example.test'
  );

INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000f11',
    '00000000-0000-4000-8000-0000000000f1',
    'access-audit@example.test',
    '访问审计测试账号',
    'active'
  );


-- ── 无会话 ──────────────────────────────────────────────────────────────────
-- 没有可信身份时**什么都不写**：无 actor 的「访问审计」没有意义，
-- 而且会让这条 RPC 变成任何人都能往里插行的入口。
SELECT
  is(
    ops.record_access_audit ('auth.login', 'req-1') ->> 'status',
    'no_operator',
    '没有活跃运营账号时不写任何东西'
  );


SELECT
  is(
    (
      SELECT
        count(*)::integer
      FROM
        ops.audit_events
      WHERE
        entity_type = 'operator_session'
    ),
    0,
    '无会话调用没有产生审计行'
  );


-- ── 有会话 ──────────────────────────────────────────────────────────────────
-- 注意顺序：写审计时带 `authenticated` 身份（账号没有 audit.read，看不到这张表），
-- 所以「读回来断言」必须在不切角色的情况下做，否则 RLS 会把行藏起来，
-- 断言会以「NULL ≠ 期望值」的形式失败，看起来像 actor 没写进去。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}',
    TRUE
  );


SELECT
  is(
    ops.record_access_audit ('auth.login', 'req-2') ->> 'status',
    'ok',
    '登录写一条访问审计'
  );


SELECT
  is(
    (
      SELECT
        audit.actor_operator_id
      FROM
        ops.audit_events AS audit
      WHERE
        audit.action = 'auth.login'
    ),
    '00000000-0000-4000-8000-000000000f11'::uuid,
    'actor 落的是本人，不是参数里传进来的字符串'
  );


-- 词表之外的动作为什么要拒：这张表是留痕用的，
-- 放开词表等于让人往审计里灌垃圾。
SET LOCAL ROLE authenticated;


SELECT
  is(
    ops.record_access_audit ('ops.export_all', 'req-3') ->> 'status',
    'unknown_action',
    '只认 auth.login / auth.logout 两个动作词'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
