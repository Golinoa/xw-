# 契约与类型一致性约束

> 状态：项目红线　|　生效日期：2026-10-29　|　适用范围：`apps/api`、`apps/web`、`packages/contracts` 及后续 `ops` 运营 API
>
> 本文回答一个问题：**怎么保证代码写下去不走形、前后端字段永远对得上。**
> 每条约束都绑定一个可执行的阻断入口；没有执行入口的规则不算约束。

## 1. 唯一真源

1. **所有跨端 DTO 只能用 zod 定义在 `packages/contracts/src`**，类型一律 `z.infer` 推导。
   禁止在 `apps/**` 里手写 `interface` 充当 API 契约。目标站字段没确认时，先在
   `Docs/REPLICATION_SPEC.md` 标缺口，不要在契约里编字段。
2. **全仓只允许一份 zod**：从 `@erp/contracts` 取 `z`，不要在 apps 里单独装 zod。
   两份 zod 会让 schema 类型互不兼容，且让前端包体翻倍。
3. **只能从包入口导入**：`import { ... } from '@erp/contracts'`。
   `../../packages/contracts/src/...` 这类深路径由 ESLint `no-restricted-imports` 阻断。
4. **每个端点必须先注册**到 `ROUTES`（`method` + `path` + `request?` + `response`），
   再写路由实现。`path` 引用 `ROUTES.x.path`，不要在 handler 里重复手写字符串。

## 2. 请求边界

5. **入站必须解析**：`parseJson` / `parseParams` / `parseQuery`（`apps/api/src/lib/contract.ts`）。
   禁止直接 `await context.req.json()`、禁止 `context.req.param('id')` 不校验就下传数据库。
6. 校验失败统一返回 `400 VALIDATION_ERROR`，`details.issues` 只含字段路径与错误类型，
   **绝不回显用户提交的原值**（避免把证件号、金额回写进日志与响应）。

## 3. 响应边界

7. **出站必须 `respond()`**：`respond(context, 'routeKey', data, status?)`。
   禁止 `context.json(...)`（ESLint `no-restricted-syntax` 在 `routes/**`、`modules/**` 阻断）。
   `respond()` 会用同一份 response schema 校验出站数据：
   - 多字段 → 自动剥离（白名单，避免内部字段泄漏）；
   - 少字段 / 类型不符 → `500 INTERNAL_ERROR` + 结构化日志 `response_contract_violation`。
8. **响应形态已裁定，不再摇摆**：
   - 成功：直接返回资源体（如 `{ userId, memberships }`），不套 `{ success, data }`。
   - 失败：扁平 `{ code, message, requestId, details? }`（`apiErrorBodySchema`）。
   - 原先 `packages/contracts/src/http.ts` 里的 `ApiResponse<T>` 信封**已删除**。理由：
     4 个已上线端点、全部 API 测试与 E2E 都是按裸资源体写的；保留一个没人实现、
     前端还按 `body.error.message` 解析的死类型，正是「走形」的典型来源
     （旧前端取 `body.error?.message`，服务端返回 `body.message`，用户永远看到
     `请求失败 (400)` 而不是真实原因）。要改成信封必须是一次显式的兼容迁移，不能顺手加。

## 4. 字段约定

| 类型 | 约定 | 反例 |
|---|---|---|
| 字段命名 | 小驼峰 JSON | `organization_id` |
| ID | 服务端生成的字符串（当前 DB 为 uuid） | 客户端自增数字 |
| 日期时间 | ISO 8601 UTC 字符串（`2026-10-29T02:00:00Z`） | 本地时区、`Date` 对象直传 |
| 金额 | `number`（精确到分）并注明币种字段，禁止字符串混用 | `"1,200"` |
| 枚举 | 常量对象 + `z.enum`，联合类型由它派生 | handler 里散落字符串字面量 |
| 可选字段 | 用 `.optional()`；**不要**用 `null` 表示缺失 | `field: null` 与缺失语义混用 |
| 布尔 | `true/false`，不用 0/1 | `status: 1` |

新增枚举/错误码/权限只能改 `packages/contracts`，改完两端自动跟着变。

## 5. 前端边界

9. **前端只能通过 `createApiClient`（`apps/web/src/lib/api-client.ts`）调后端**，
   组件与 store 内禁止裸 `fetch`。客户端负责：附加 `Authorization`、
   `X-Organization-ID`、请求前 schema 自检、响应 schema 解析、错误码映射中文、
   4xx 不重试 / 5xx 最多重试 3 次、401 换一次令牌后重试。
10. 业务代码**不解析后端 `message`**，只按 `code` 映射文案（`ERROR_MESSAGES`）。
    服务端 message 是给运维看的，不是给用户看的。

## 6. 变更流程

11. 改契约的顺序固定：**改 contract → 补测试 → 改 API → 改前端 → 跑门禁**。
    顺序颠倒会出现「前端先合并、后端还没上」的窗口期。
12. 破坏性变更（删字段、改类型、改路径）必须在 journal 记录迁移方案，
    并确认 Admin/ops 端同步；当前没有 `/api/v1` 版本前缀，不要凭空声称有。
13. 新增端点必须同时给出：契约、至少一个正向用例、至少一个拒绝用例
    （越权/跨租户/非法输入任选其一）。

## 7. 四层守卫（现状）

| 层 | 机制 | 失败表现 | 入口 |
|---|---|---|---|
| 编译期 | `z.infer` 是唯一类型来源 | `tsc` 报错 | `pnpm typecheck` |
| 出站 | `respond()` 用 response schema 校验 | `500` + `response_contract_violation` 日志 | `apps/api/src/contracts/response-guard.test.ts` |
| 入站 | `api client` 用 response schema 解析 | `ContractViolationError`（含字段路径） | `apps/web/src/lib/api-client.test.ts` |
| 清单 | `ROUTES` ↔ Hono 实际路由双向对账 | 测试失败并列出缺失/多余路由 | `apps/api/src/contracts/route-parity.test.ts` |

## 8. 仍未覆盖的洞（明确记录，不要假装已解决）

1. **数据库 schema 没有生成 TS 类型**。SQL migration 改了列，契约不会自动报错，
   只能靠出站校验在运行时抓到。后续动作：`supabase gen types typescript` 产出
   `packages/contracts/src/db.ts`，并让 `pnpm schema:check` 同时校验「生成的 DB 类型
   与 migration 一致」。**前置条件**：本机需要可用 Supabase CLI 或 Docker
   （当前都没有，WSL 被安全策略拦截），因此这项卡住，不是遗漏。
2. **没有 OpenAPI 文档**。对外（如 Admin 端、未来的第三方）无法自助对接。
   可在 zod 稳定后从 `ROUTES` 生成，但当前不引入 codegen 流水线。
3. **错误码与 HTTP 状态码的映射是约定而非类型**。`ApiHttpError` 接受任意
   `status + code` 组合，暂无编译期约束。
4. **分页/排序/过滤参数未统一**。约定在第一个列表功能（Task 4 主数据）落地时
   一次性定死 `page`/`pageSize`/`sort` 契约，再回填文档，避免各页面各写一套。

## 附录 A：为什么选 zod-first（方案评估）

| 方案 | 一致性强度 | 成本 | 结论 |
|---|---|---|---|
| **zod-first 共享包（采用）** | 强：单一 schema 同时产出类型、入站校验、出站校验、清单 | 低：zod 已是 pinned 依赖，零 codegen | 选它 |
| OpenAPI-first + 生成客户端 | 最强：文档即契约 | 高：要维护 yaml、跑 codegen、Workers 构建链路变长；1 人团队不划算 | 暂不采用；等有外部对接方再评估 |
| tRPC | 最强（同构 TS） | 中：把前端锁死在同一 TS 单体 | 不采用：Admin 是**独立前端、跨仓消费**同一 Hono API，tRPC 直接堵死这条路 |
| 只靠 DB 生成类型 | 弱：只管到数据层，管不到 HTTP 边界 | 中：依赖 CLI/Docker | 作为补充（见 §8.1），不能替代 HTTP 契约 |
| 手写 interface（现状之前） | 无：靠人记 | 低 | 已淘汰：API 侧 4 个端点里已经出现 `body.error.message` 与 `body.message` 不一致 |

结论：当前栈（Hono + Workers + 无 ORM + 手写 SQL）下，**zod-first 是唯一能在不加
构建步骤的前提下同时守住前后端字段一致的做法**。代价是「出站校验多一次 parse」，
在 Worker 上可忽略。

## 附录 B：新增一个端点的固定动作

1. `packages/contracts/src/<domain>.ts`：定义 `xxxRequestSchema` / `xxxResponseSchema`。
2. `packages/contracts/src/routes.ts`：在 `ROUTES` 加一项（`method`/`path`/`request`/`response`）。
3. `apps/api/src/modules/<domain>/routes.ts`：`parseParams` → `parseJson` → 服务层 → `respond`。
4. `apps/web/src/lib/…`：`api.call('<routeKey>', { params, body })`，返回值自动是 `RouteResponse<K>`。
5. 测试：正向 + 拒绝用例；跑 `pnpm typecheck && pnpm lint && pnpm test`。
6. `route-parity.test.ts` 会自动确认你没有漏挂路由。

## 相关文档

- [API and permission standards](API_STANDARDS.md)
- [Code writing standards](CODE_STANDARDS.md)
- [Database standards](DATABASE_STANDARDS.md)
- [Testing standards](TESTING_STANDARDS.md)
- [架构说明](../ARCHITECTURE.md)
