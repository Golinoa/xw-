-- 登录端点要回答的那个问题：这个账号「不是运营成员」还是「成员被停用」。
--
-- `ops.get_current_ops_context()` 的 WHERE 带 `status = 'active'`，对这两种情况
-- **同样**返回零行。它回答的是「是不是有效成员」，不是「为什么不是」——这个
-- 选择在 `/session` 那里是对的（拿不到上下文就不该看到任何运营数据），到了登录
-- 就变成缺一块信息：契约 §5.1 要求 403 带 `OPS_MEMBER_MISSING` 或
-- `OPS_MEMBER_INACTIVE`，两个原因指的人不同。
--
-- 补法有两条，这里选的是不放开 RLS 的那条。另一条是让停用账号能读到自己的
-- 运营行，代价有两个：停用原因、邀请人这些字段跟着暴露；以及「读得到自己的行」
-- 与「是有效成员」从此变成两件事，后续每个策略都得重新判断自己依赖哪一个。
--
-- 形状上刻意无参数：身份取自 `auth.uid()`（PostgREST 验签后的令牌），调用方
-- 没有办法拿别人的 uid 来问。返回值只有一个状态词，不含邮箱、停用原因、
-- 停用时间——这些在未登录时都不该给。
CREATE OR REPLACE FUNCTION ops.login_member_state () returns text language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(
    (
      select case
        when operator.status = 'active' then 'active'
        else operator.status
      end
      from ops.operators as operator
      where operator.user_id = (select auth.uid())
      limit 1
    ),
    'missing'
  );
$$;


-- 与其余五个函数同一套授权：anon 一行都不给，authenticated 可以调。
-- service_role 也授，但 `auth.uid()` 在它是空，因此它永远只会拿到 'missing'。
REVOKE ALL ON function ops.login_member_state ()
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.login_member_state () TO authenticated,
service_role;


COMMENT ON function ops.login_member_state () IS '登录端点专用：返回 active / invited / disabled / missing。无参数，身份取自 auth.uid()。';