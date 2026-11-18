-- 访问审计：登录/登出此前完全没有记录
--
-- 缺口不是「没写审计」，而是**没有任何地方能写**：`ops.write_audit` 从
-- `auth.uid()` 取 actor，而登录的那一刻恰好还没有会话（令牌刚签发，还没被使用过）。
-- 结果就是「账号被人登过」这件事在库里查不到。
--
-- 解法：登录成功后，运策端**拿着刚拿到的那个令牌**调这个 RPC。
-- 那一刻 `auth.uid()` 已经是本人，actor 自然正确，不需要把 actor 作为参数传进来——
-- 传进来就意味着「谁都能替别人写审计」，那比不记还糟。
--
-- 只允许两个动作词：这张表是留痕用的，放开词表等于让人往审计里灌垃圾。
-- 失败登录（密码错）**不记**：那时没有可信身份，记下来的「actor」只能是别人填的字符串；
-- 这类事件走请求日志与速率限制，不进审计表。

CREATE OR REPLACE FUNCTION ops.record_access_audit (
  p_action text,
  p_request_id text DEFAULT NULL,
  p_detail jsonb DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid;
  event_id uuid;
begin
  if p_action is null or p_action not in ('auth.login', 'auth.logout') then
    return jsonb_build_object('status', 'unknown_action');
  end if;

  actor_id := ops.current_operator_id();

  -- 没有活跃运营账号就什么都不写：无 actor 的「访问审计」没有意义，
  -- 而且会让这条 RPC 变成任何人都能往里插行表的入口。
  if actor_id is null then
    return jsonb_build_object('status', 'no_operator');
  end if;

  event_id := ops.write_audit(
    p_action,
    'operator_session',
    actor_id,
    null,
    null,
    p_detail,
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'eventId', event_id);
end;
$$;


REVOKE ALL ON function ops.record_access_audit (text, text, jsonb) FROM public, anon;

GRANT
EXECUTE ON function ops.record_access_audit (text, text, jsonb) TO authenticated;
