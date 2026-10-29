# 有单·旅游管理系统架构

项目名称：**有单·旅游管理系统**。当前架构以已确认的 [技术选型](Docs/TECH_SELECTION.md) 为准。

## 分层与请求路径

`Web UI (Vue 3) -> API (Hono on Cloudflare Workers) -> Auth/Domain services -> Supabase PostgreSQL (RLS/RPC)`。前后端逻辑分离，首期采用单 Worker 部署，不拆微服务。对象存储目标为七牛云；由于当前没有经确认的前端上传/下载流程，暂不开发存储集成。

## 依赖规则

- Vue 页面与组件只负责交互和视图组合，通过共享 API 契约调用服务端。
- API 路由负责 HTTP 输入输出、鉴权上下文和验证，并将业务操作交给领域/应用服务。
- 服务端从可信会话取得用户与组织上下文；禁止信任客户端提交的租户归属。
- PostgreSQL RLS 是数据隔离的纵深防御；服务端权限检查与 RLS 都必须存在。
- Worker 只在 Supabase 会话验证并确认调用者是指定组织成员后，才将 `X-Organization-ID` 作为 PostgREST 请求上下文；组织发现/创建请求不带所选组织。数据库 `current_organization_id()` 从 PostgREST 事务请求头读取该值，并再次用 `auth.uid()` 校验成员关系。缺失、畸形或非成员上下文均无法读取组织数据；成员撤销后，后续 Worker 请求和 RLS 请求会重新校验成员关系。
- 领域规则不得依赖 UI、HTTP 框架或供应商 SDK。共享契约承载稳定的请求、响应、错误码和权限类型。
- 数据库结构以项目 SQL migrations、RLS 策略和事务函数为准；目标站复刻规格中的概念模型不代表物理 schema。
- 外部服务通过明确的适配边界接入；密钥只能保存在 Worker secrets，不得进入前端构建产物。
- 避免循环依赖、跨层直连和未经需求证明的微服务拆分。

## 契约与类型一致性

跨端字段的唯一真源是 `packages/contracts` 里的 zod schema。同一份 schema 同时承担四种职责，
不允许任何一端另写一份字段定义：

```text
packages/contracts/src/<domain>.ts   zod schema
        ├─ z.infer                        → TS 类型（两端共用）
        ├─ ROUTES.request                 → API 入站校验（parseJson/parseParams/parseQuery）
        ├─ ROUTES.response                → API 出站校验（respond()）
        └─ ROUTES.response                → 浏览器解析（api-client）
```

- `ROUTES`（`packages/contracts/src/routes.ts`）是端点清单；路由路径引用 `ROUTES.x.path`，不重复手写字符串。
- 成功响应返回资源体本身，失败响应返回扁平 `{ code, message, requestId, details? }`；不使用 `success/data` 信封。
- 服务端出站数据与 schema 不符时 fail closed（`500 INTERNAL_ERROR` + `response_contract_violation` 日志），
  多出的字段被剥离，不会泄漏内部字段；浏览器侧解析失败抛 `ContractViolationError` 并带字段路径。
- `ROUTES` 与 Hono 实际路由做双向对账，任一端多出条目即测试失败。
- 前端只能通过 `apps/web/src/lib/api-client.ts` 调后端；组件内禁止裸 `fetch`。

完整约束、字段约定与方案评估见 [`.harness/CONTRACTS.md`](.harness/CONTRACTS.md)。

## 信息来源

技术细节、部署和测试策略见 `Docs/TECH_SELECTION.md`；产品行为和目标站证据见 `Docs/REPLICATION_SPEC.md`。
