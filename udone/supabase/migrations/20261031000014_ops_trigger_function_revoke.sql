-- 补一条漏掉的 REVOKE：`ops.entitlement_snapshot_immutable()` 是 o-t10（权益域）
-- 建出来的触发器函数，但那个迁移末尾的 20 多条 `REVOKE ALL ON function …` 里没有它，
-- 于是它保留了函数的默认 ACL —— **PUBLIC 可执行**，`anon` 也就可执行。
--
-- 为什么不是改 o-t10 的迁移：迁移是历史，改它等于让已经跑过的库与文件对不上。
-- 补一条新的，是为了让「什么时候发现、什么时候修的」留在文件里。
--
-- 今天不可利用，两条独立的原因：
--   1. Postgres 拒绝直接调用触发器函数（`trigger functions can only be called
--      as triggers`），所以 anon 即使有 EXECUTE 也叫不起来；
--   2. `anon` 没有 `ops` schema 的 USAGE，连函数名都解析不到。
-- 但它仍然要修：这套代码反复声称的不变量是「ops 下所有函数的 EXECUTE 都不给
-- public/anon」，而一条恒真的断言只能建在全量成立的基础上。留着这一个例外，
-- 等于把「异常」当成默认接受——下一个人写 `REVOKE` 清单时会照着这份漏过的样子抄。
--
-- 发现过程：写跨域拒绝对照表（`supabase/tests/ops_cross_domain_denials.sql`）时
-- 用表驱动扫了 `has_function_privilege('anon', p.oid, 'EXECUTE')`，全库只命中这一个。
REVOKE ALL ON FUNCTION ops.entitlement_snapshot_immutable ()
FROM
  public,
  anon;