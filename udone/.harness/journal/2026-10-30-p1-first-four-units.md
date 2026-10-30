# 2026-10-30 · P1 前四单元（U01 / U02 / U03 / U04）

## 本轮做了什么

按 `2026-10-30-long-run.md` §4 推进 P1 前四单元。三者文件互不重叠，所以 U01/U03/U04
并行实现、各自提交；U02 依赖 U01 的身份基座，排在后面。四个单元全部收口。

| 单元 | 卡 | 提交 | 出口 |
|---|---|---|---|
| U01 | `o-t02` | `edc1b6a` | 6 表 + 5 函数 + 39 码 / 6 角色 seed；pgTAP **34** 断言 |
| U03 | `o-cors` | `be56f79` | 凭证按来源授予；单测 11 条 |
| U04 | `o-testjwt` | `dd4e254` | 签发入口 + 独立开关 + 部署门禁 |
| U02 | `o-t01` | `391063c` | `GET /api/v1/ops/meta` 真实链路；集成 5 条 |

## 四处判断（都不是照抄计划）

1. **schema USAGE 要开给 `authenticated`**。上一轮 `20261030000001` 只授了
   `service_role`，注释写的是「客户端令牌连 schema 的 USAGE 都没有」。读契约 §7.2
   才发现方向反了：契约要求 Worker 用**用户令牌**调 PostgREST 让 RLS 逐行判定，
   并把 `service_role` 明确排除在请求路径之外。差别不在宽松程度，而在**哪一层
   负责拒绝**——不开 USAGE 只能表达「不许进 ops」，表达不了「这个运营只能看这些行」。
   已按契约改，`anon` 仍无 USAGE，P1 不变。
2. **五个函数必须 `SECURITY DEFINER`**，理由不是提权而是打断递归：`ops.operators`
   的 SELECT 策略调 `current_operator_id()`，该函数要查 `operators`；以调用者权限
   执行会 infinite recursion。
3. **CORS 的 ACAC 不能交给 hono 的 `credentials: true`**。读源码确认它无条件设置，
   不看来源是否命中——被拦来源也会收到「可以带凭证」，只剩 ACAO 缺失在拦。
   改法是把「来源是否允许」抽成一个函数，回声与凭证读同一处，凭证在 cors 之后补。
4. **不自己验签**。PostgREST 已经验签才会执行 RPC；再验一遍等于第二份判定实现，
   症状会是「同一令牌 RPC 通、中间件不通」。

## 变异验证（每条都确认「改坏它会红」）

| 单元 | 变异 | 结果 |
|---|---|---|
| U01 | `current_operator_id()` 去掉 `status='active'` | 红 2 条：invited / disabled 各一条 |
| U01 | 审计策略只判成员、不判 `audit.read` | 红：support_agent 读到 1 行审计 |
| U01 | 给 `ops.audit_events` 授 `UPDATE` | 红：P7「审计不可改写」 |
| U03 | 退回 `credentials: true` 并去掉条件补头 | 红 3 条（含「未命中来源不得有 ACAC」） |
| U04 | 生产配置里加 `ALLOW_LOCAL_JWT_AUTH` | `check:deploy` 红 |
| U04 | 开关改成 `Boolean(...)` | 红：「只认字符串 true」 |
| U02 | RPC 零行当成未登录 | 红 2 条 403 |
| U02 | 去掉 `Content-Profile` | 红 3 条（含成功路径） |
| U02 | 去掉 `Accept-Profile` | **仍绿** —— 见下 |

最后一条是本轮唯一一次「变异没红」。原因是 POST RPC 靠 `Content-Profile` 定位函数，
`Accept-Profile` 只管响应 schema 解析。我没有为了让它红去改断言，而是**改了口径**：
注释从「两个头都要带」改成「只有 Content-Profile 是必需的」，并写明这条是变异验证过的。
把不成立的话留在注释里，比没有注释更贵——下一个人会照着它去排查。

## 一处连带修复

`OPS_ROUTES` 一有条目，`RouteKey` 就变成两张表的并集，而 `apps/web` 的 api client
用 `RouteKey` 约束 `call()`，于是**类型层**允许租户前端调用运营端点——它既没有运营
令牌，也不该走那条路径。新增 `BusinessRouteKey = keyof typeof ROUTES`，前端 client
改用它。这类问题只有在第一次往 `OPS_ROUTES` 里登记时才暴露，晚了就是运行期 401。

## 当次门禁实测

```
board:check ✓   format ✓   format:sql(30) ✓   lint+CSS token ✓   schema(16) ✓
check:deploy ✓  typecheck(含 .vue) ✓   test 42 文件 308 用例 ✓   build 1,638.08 kB
db:local:verify 12 文件 223 断言 ✓   db:local:http 4 文件 29 条 ✓
```

## 断点（2026-10-30 14:4x）

- 本单元：U01~U04 已收口
- 已完成：身份基座（6 表 5 函数 39 码）、`/meta`、受控 CORS 凭证、测试签发通道
- 未完成：**U05 登录代理**（GoTrue 代理 + HttpOnly cookie + 429 限流）、U06 `/session` + `/permissions`
- 下一单元：U05 —— `apps/api/src/modules/ops/auth/`（login/refresh/logout）
- 阻塞：无。U05 的 GoTrue 上游本地仍是替身，验收必须拆两段写，不许合成「登录已验证」
- 环境：迁移 16 个；pgTAP 12 文件 223 断言；集成 4 文件 29 条
