# 2026-10-29 本地数据库验证环境

## 今日完成

**把「从未执行的 DDL」变成了真的跑过一遍。** 之前三个切片的 8 条 RLS 策略、5 个事务函数
只有格式检查和清单检查，`pnpm db:test` 一次都没跑起来过（本机无 Docker、无 Supabase CLI，
WSL 被安全策略拦）。这次用原生 PostgreSQL 17 + 一层最小 Supabase 兼容层把它补上了。

- `scripts/db/local-db.mjs`：`pnpm db:local:setup` 下载 PostgreSQL 与 pgTAP（仓库外
  `$HOME/.udone-local-pg`），`pnpm db:local:verify` 从空库重放 10 个迁移并用真实角色跑 pgTAP。
- `scripts/db/supabase-shim.sql`：只补迁移真正依赖的东西——三个角色（`service_role`
  带 `BYPASSRLS`，与平台一致）、`auth.users` 最小列、`auth.uid()/jwt()/role()`、
  public schema 的默认授权。**刻意不模拟** PostgREST/GoTrue 的其它行为。
- 新增 3 个 pgTAP 文件（客户 15、订单 16、财务范围 15），加原有 61 条，共 **107 条断言**。

## 关键决策

- 选原生 PostgreSQL 而不是等 Docker：迁移只依赖 `auth.uid()/auth.jwt()` 和三个角色，
  没有任何扩展依赖，兼容层只有 ~90 行。代价是 PostgREST 层仍未覆盖。
- pgTAP 1.x 是纯 SQL，不用编译：官方的 `pgtap.sql` 只是把 `__OS__`/`__VERSION__`
  两个占位符替换掉，脚本里等价地做同一件事。
- 不整表授权给 `authenticated`，而是按列授权：订单号、`receivable_total`/`payable_total`、
  `version` 依旧不开放给客户端。否则「金额只由服务端算」这条不变量直接失效。
- 明细表加了 AFTER 触发器调用 `recalculate_order_totals`（该函数改为 SECURITY DEFINER）。
  这样合计与明细不可能漂移——无论写入走事务函数还是直接写表。

## 遇到的问题

**环境层面（都记在脚本注释里，避免下次重踩）**
- `pg_ctl start` 把 postmaster 派生为脱离终端的进程，这个 shell 收尾时会把它一起收掉，
  表现是「日志显示 ready，下一句连接被拒」。改成把 postgres 作为直接子进程管理。
- `process.exit()` 会截断管道上还没 flush 的 stdout，排查时只看到一个退出码、没有一行日志。
  改用 `process.exitCode` 自然退出。
- pgTAP 的 TAP 行默认被 psql 排成带边框的表格，`^ok` 匹配不上 → 失败被读成「0 个断言」而
  当成通过。必须 `-t -A`，并且「0 断言」本身要算失败。
- pgTAP 1.x 的消息正则要用 `throws_like`；`throws_ok` 的第二/三参数是精确比对。

**真正的产品缺陷（本轮修掉）**
- **建单接口在生产上是 500**：三个订单事务函数是 SECURITY INVOKER，而 `authenticated`
  只有 `orders`/明细表的 SELECT。函数内 `INSERT INTO orders` 直接
  `permission denied for table orders`。列级 UPDATE 还漏了
  `status`/`previous_status`/`customer_id`/`order_type`，状态机与订单编辑同样写不进去。
  之前的 186 个单元测试全用 mock 仓储，看不见权限层。
- **软删除的数据在 RLS 层仍可读**：`customers`/`orders` 的 SELECT 策略不看 `deleted_at`，
  靠 API 查询串过滤。Supabase 的 PostgREST 用用户 JWT 直接可达，策略不挡就只是
  「我们的代码目前没这么查」。已在策略层收紧。
  连带修正：API 的软删除原来靠 `Prefer: return=representation` 判断是否命中，
  行被策略隐藏后会「删成功却回 404」，改为先确认存在、再 `return=minimal` 提交。

## 仍未做（别当成已验收）

- **`update_order_with_items` 会丢掉已确认/在途金额。** 它把明细行整体删掉再插入，
  而插入只带 `name`/`amount`，`confirmed_amount`/`pending_amount` 回落成 0。
  于是「改个线路名」会把客户已确认的 3000 元收款抹掉，利润跟着变。
  修法需要先让更新契约带上明细行 id（按 id upsert + 删除缺失行），属于契约变更，
  不在本轮范围。**这是当前最该优先修的缺陷。**
- PostgREST 层没跑：API 的 `rest-client` 走 HTTP，本地只有 psql。要真正端到端，
  还得起 PostgREST 二进制或用 PGlite 之外的办法，成本明显高于收益。
- `scripts/db` 的 SQL 不在 `format:sql` 覆盖范围内（脚本只扫 `supabase/migrations`
  与 `supabase/tests` 顶层），目前靠人工保持一致。

## 下一步计划

1. 修 `update_order_with_items` 的明细行覆盖问题（契约带 id + upsert），这是数据正确性问题。
2. 收付款申请与确认流（R-FIN-02/03），届时引入 `finance.write` 权限与专门的确认函数，
   顺便把 `confirmed_amount` 的写入权从「无人可写」变成「只能由函数写」。
3. 全组织财务合计（SQL 聚合），现在的汇总都是按订单维度。
