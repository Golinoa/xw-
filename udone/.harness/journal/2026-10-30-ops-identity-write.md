# U07 账号与角色写侧：三条不变量进库

日期：2026-10-30 · 单元：`o-t03b`（N6 = T-03b）· 提交：`9822982`（功能）、`089b8f6`（门禁）

## 做了什么

七个端点：`GET /operators`、`POST /operators/invitations`、`PATCH /operators/{id}`、
`GET/POST /roles`、`PATCH /roles/{id}`、`GET /audit-events`。

写路径全部落在 `ops.*` 的 SECURITY DEFINER 函数里，`authenticated` 在
`operators` / `roles` / `role_permissions` / `operator_roles` 上仍然一行写权限都没有。
这一条不是「忘了给」，是契约 §7.3 的 A2 类：给了写权限，等于把「最后一个管理员不能
被移除」交给调用方自觉，而调用方是 Worker——它可能被回滚、被改坏、或在某个分支提前 return。

## 三个判断

**业务失败用信封返回，不用 RAISE。** PostgREST 把任何非 2xx 都压成状态码，
`RestConflictError` 拿不到 SQLSTATE，也不该拿到（上游错误正文回显给调用方是另一类
问题）。所以函数返回 `{status:'last_admin'}` 这样的信封，成功时才真的写。权限不足
仍然 RAISE 42501——那不是业务分支，是「有人绕过了 requireOpsAuth」，必须留下痕迹，
而不是变成一个能被前端渲染的 409。

**两条自锁在写之前判定，不靠事务回滚兜底。** 回滚能撤销写入，但撤销不了已经返回给
调用方的 500。而且 LAST_ADMIN 只在「变更造成归零」时拒绝：基线本来就是 0 的库
（异常状态）不该因此连无关的修改都做不了——那时该修的是数据，不是把接口锁死。

**`update_role` 的签名里没有 `p_code`。** 契约写「系统角色不可改 code/删除」。运行
时判 `is_system` 是一种做法，但让「改 code」这件事在接口形状上不存在更难绕过。
pgTAP 里有一条断言直接读 `pg_proc.proargnames` 确认没有 `code`/`p_code` 参数——
它防的是「以后为了让某个页面方便，顺手加一个」。

## 验收分层（结论不混算）

| 层 | 覆盖 | 证明了什么 |
|---|---|---|
| pgTAP 48 条 | 表、RLS、函数 | LAST_ROLE / LAST_ADMIN / 乐观锁 / 审计摘要 / 权限版本 / 形状函数未授权 |
| 集成 17 条 | 真实 PostgREST + RLS | 401、403×2、409×3、201、200 都是真跑出来的 |
| 单测 14 条 | 信封 → HTTP 的翻译 | 排序键映射、错误码映射、形状漂移 503 |

**邀请的 GoTrue 上游是注入替身**（本地没有 `/auth/v1`），它只回一个 auth 用户 id。
之后的一切——角色校验、邮箱唯一、审计写入——都是真的。所以「邀请已验证」这句话
只对后半段成立。同理，`invitationExpiresAt` 按 GoTrue 默认 24h 估算，未在真机确认。

## 变异九枪全红

| 变异 | 红了什么 |
|---|---|
| 去掉 LAST_ADMIN 判定 | 24 通过 1 失败 1 报错（停用了唯一管理员，后面的调用 42501） |
| 去掉 LAST_ROLE 判定 | 43 通过 5 失败 |
| 去掉乐观锁比较 | 45 通过 3 失败 |
| 去掉 permission_version 自增 | 46 通过 2 失败 |
| 审计动作名改一个字 | 47 通过 1 失败 |
| 列表漏 `mfa_required` | 47 通过 1 失败 |
| 排序键不做映射 | 单测 1 失败 |
| 动作码判定改空操作 | 单测 1 失败 |
| 版本冲突报成状态冲突 | 单测 1 失败 |

## 顺带修掉一个门禁洞

写侧 pgTAP 第一版写 `plan(49)`，实际只跑了 48 条，而 `db:local:verify` 报的是 **ok**。
原因：pgTAP 对计划数不符只打一行 `# Looks like you planned 49 tests but ran 48`，
既不是 `not ok`，也不改 psql 退出码，于是「少跑一条断言」与「全绿」完全同形。

补了计划数与实际数的比较（`089b8f6`），并排在 `failed/crashed` 之后输出：执行中途
报错时先说「报错了」再说「少了几条」。变异：`plan(48)→plan(49)` 一张，红。

这个洞值得记下来，因为它解释了另一件事——**为什么 M1 那枪最初只报「计划对不上」**。
去掉 LAST_ADMIN 之后唯一的管理员被停用，后续每条 `require_permission` 都直接 42501，
测试在第 25 条中断。断言的数字对不上只是症状，症状说对了原因，才谈得上排查。

## 未决（已登记，不假装已验证）

- 邀请链接有效期按 GoTrue 默认 24h 估算 → 真机才能确认。
- 邀请是**跨系统两阶段写，不原子**：GoTrue 建号成功、ops 行被拒时残留一个没有运营
  身份的 auth 用户。Worker 没有删 auth 用户的路径，所以不假装回滚，落一条
  `ops_invitation_orphan_user` 日志把 userId 交给运维。
- `invited → active` 没有自动触发点，`displayName` 没有写入入口 → 协作项 `C-98`。
- 审计 action 词表只定了两条，实现补了三条 → 协作项 `C-97`。
- P4/P5/P13 要等 `ops.customers` / `ops.receipts` 落地（P2）才能在真实表上断言。

## 门禁实测

`format` · `format:sql`(33) · `lint`+CSS · `schema:check`(18 迁移) · `check:deploy` ·
`typecheck`（含 .vue）· `test` 45 文件 **343** 用例 · `db:local:verify` 14 文件 **277**
断言 · `db:local:http` 7 文件 **57** 条 · `build`（主 chunk 1,638.11 kB）· `board:check`
——十一条全绿。

## 下一步

`o-t04` 客户主数据（P2 第一块）：`ops.customers` + `ops.customer_contacts`，
`GET/POST /customers`、`GET/PATCH /customers/{id}`、`POST /customers/{id}/transition`、
`GET /customers/{id}/contacts`。客户是 A1 类（白名单列直写）与 A2 类（状态机走 RPC）
混在一起的第一个域，表结构要先想清楚哪几列在白名单里——`status` 不在，`owner_operator_id`
也不在（它要在客户停用时仍可追溯）。
