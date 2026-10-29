# P0 架构加固实施计划（CORS / 令牌 / REST 客户端 / 请求治理 / 可观测性 / CI）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers/subagent-driven-development 或 superpowers/executing-plans。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 消除 2026-10-29 技术评审中「不修就干不下去」的阻断项，并把三项结构隐患收敛成可验证的实现，为 Task 4（主数据）提供安全的地基。

**Architecture:** 保持单 Worker 模块化单体不变。新增能力全部以「中间件 + 可注入接口」形式接入，不引入新的运行时依赖（CORS 复用 `hono/cors`）。所有跨端字段仍以 `packages/contracts` 的 zod schema 为唯一真源。

**Tech Stack:** Hono + Cloudflare Workers、Vue 3、Vitest、pnpm workspace、Gitee Go 流水线。

**Spec:** 本文件 + `.harness/CONTRACTS.md` + `ARCHITECTURE.md`。上一轮契约改造已提交于 `7ba3eb7`。

## 本轮决策（已由用户确认）

| 决策 | 结论 |
|---|---|
| 推进范围 | P0 架构加固全量（不涉及外部账号依赖，本地全绿可验证） |
| CI 归属 | 迁到 Gitee Go，`.workflow/*.yml`；Gitee 为开发主库 |
| 令牌存储 | `sessionStorage`，关闭 localStorage 长期驻留；httpOnly BFF 记为后续目标 |

## 明确排除（YAGNI）

- **不做 cron 定时任务**：当前没有任何周期性作业，等 Task 5 结算/通知真正需要时再配 `[triggers] crons`。
- **不做 Redis/KV/DO 版限流与幂等**：本轮用内存实现 + 明确边界标注；跨实例一致性留到需要多实例时（Worker 免费版内存实例本就短命，先把契约立住）。
- **不做 BFF/httpOnly Cookie**：独立工程量，超出 P0。
- **不做分页/排序/过滤契约**：按上一轮结论，在 Task 4 主数据落地时一次性定死。
- **不引入 OpenAPI/codegen**：见 `.harness/CONTRACTS.md` 附录 A。

## Global Constraints

- 每个任务先写测试再写实现（TDD），失败测试必须亲眼看到红，再写最少实现让它绿。
- 不得削弱任何既有门禁；`pnpm lint / typecheck / test / build / check:deploy / schema:check / format:check` 全绿才算完成。
- 环境变量新增必须同时落在三处：`apps/api/src/env.d.ts`、`.env.example`、`scripts/check-deploy-config.ts` 断言。
- 安全默认拒绝：CORS 未配置 = 不放行任何跨域来源；禁止 `*` 与凭据组合。
- 内存态存储（幂等/限流）必须在代码注释与 `.harness/CONTRACTS.md` 标注「单实例有效」，不得对外宣称分布式一致。
- Gitee Go 流水线必须以**实际跑通**为完成标准；仅写完 yml 不算完成，也不得声称 CI 已生效。

## Files and Ownership Map

- `apps/api/src/middleware/cors.ts`：跨域白名单与预检响应；不含业务逻辑。
- `apps/api/src/middleware/idempotency.ts`：写请求幂等键解析与响应回放。
- `apps/api/src/middleware/rate-limit.ts`：固定窗口限流与 429 响应。
- `apps/api/src/lib/rest-client.ts`：PostgREST / Supabase Auth 的唯一 HTTP 出口（超时、头、错误映射）。
- `apps/api/src/lib/idempotency-store.ts`、`apps/api/src/lib/rate-limit-store.ts`：可注入的存储实现。
- `apps/web/src/lib/supabase.ts`：浏览器会话存储策略。
- `wrangler.toml`、`.workflow/ci.yml`：部署与流水线配置。

---

## 阶段 A：CORS（解除 admin 跨域阻断）

### 任务 A1：用测试钉住 CORS 行为（RED）

- 文件路径：`apps/api/src/middleware/cors.test.ts`（新建）
- 要做的：写 5 个用例，全部指向尚未存在的 `./cors`：
  1. 允许来源发起带 `Origin` 的 GET，响应含 `access-control-allow-origin` 且等于该来源、不等于 `*`；
  2. 未在白名单的来源，响应**不含** `access-control-allow-origin`；
  3. `OPTIONS` 预检返回 204，且 `access-control-allow-headers` 含 `Authorization`、`X-Organization-ID`、`Idempotency-Key`；
  4. `ALLOWED_ORIGINS` 为空/未定义时，任何来源都不放行；
  5. 配置里出现 `*` 时被过滤掉（`parseAllowedOrigins('*')` 返回 `[]`）。
- 验证：`npx vitest run apps/api/src/middleware/cors.test.ts` 失败，且报错是「模块不存在」而非断言错误。

### 任务 A2：实现 CORS 中间件（GREEN）

- 文件路径：`apps/api/src/middleware/cors.ts`（新建）
- 要做的：
  - `parseAllowedOrigins(raw?: string): string[]`：逗号分隔、`trim`、去尾斜杠、过滤空串与 `*`。
  - `corsMiddleware(): MiddlewareHandler<ApiEnvironment>`：包装 `hono/cors`，`origin` 回调按 `c.env.ALLOWED_ORIGINS` 判定，命中返回原 origin，否则返回 `''`；`allowMethods: ['GET','POST','PATCH','DELETE','OPTIONS']`；`allowHeaders: ['Authorization','Content-Type','X-Organization-ID','Idempotency-Key','X-Request-ID']`；`exposeHeaders: ['X-Request-ID','Retry-After']`；`maxAge: 600`；`credentials: false`。
- 验证：任务 A1 的 5 个用例全绿。

### 任务 A3：接入应用并补环境变量契约

- 文件路径：`apps/api/src/index.ts`、`apps/api/src/middleware/auth.ts`（`ApiEnvironment.Bindings`）、`apps/api/src/env.d.ts`、`.env.example`、`scripts/check-deploy-config.ts`
- 要做的：
  1. `index.ts` 在 `requestId()` 之后、路由之前 `app.use('*', corsMiddleware())`；
  2. `Bindings` 增加 `ALLOWED_ORIGINS?: string`；
  3. `env.d.ts` 同步声明；
  4. `.env.example` 追加注释块与 `ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5555`；
  5. `check-deploy-config.ts` 增加断言：`.env.example` 必须含 `ALLOWED_ORIGINS`，且不得为 `*`。
- 验证：`npx vitest run apps/api` 全绿；`pnpm check:deploy` 通过；`npx tsc --noEmit -p apps/api` 无错误。

---

## 阶段 B：令牌存储（收窄 XSS 会话窗口）

### 任务 B1：用测试钉住会话存储策略（RED）

- 文件路径：`apps/web/src/lib/supabase.test.ts`（新建）
- 要做的：`vi.mock('@supabase/supabase-js')` 捕获 `createClient` 的第三个参数，断言：
  1. `options.auth.storage` 取到的是 `sessionStorage`（用 `vi.stubGlobal('sessionStorage', fake)` 注入替身并比对同一引用）；
  2. `options.auth.persistSession === true`；
  3. `options.auth.autoRefreshToken === true`；
  4. 未配置 URL/key 时导出仍为 `null`。
- 验证：`npx vitest run apps/web/src/lib/supabase.test.ts` 红灯。

### 任务 B2：切换到 sessionStorage（GREEN）

- 文件路径：`apps/web/src/lib/supabase.ts`
- 要做的：把 `auth` 配置改为
  ```ts
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: globalThis.sessionStorage,
  },
  ```
  并在文件顶部注释说明：令牌不落 localStorage，关标签即失效；迁移到 httpOnly Cookie 需后端代理 Auth，另行立项。
- 验证：任务 B1 四个用例全绿；`npx tsc --noEmit -p apps/web` 无错误。

---

## 阶段 C：统一 REST 出口（消除 5 处裸 fetch）

### 任务 C1：用测试钉住 REST 客户端契约（RED）

- 文件路径：`apps/api/src/lib/rest-client.test.ts`（新建）
- 要做的：用 `vi.stubGlobal('fetch', ...)` 覆盖 6 个用例：
  1. `request('/rest/v1/x')` 拼出 `${SUPABASE_URL}/rest/v1/x`，且带 `apikey`、`Authorization: Bearer <token>`、`Content-Type: application/json`；
  2. 传 `organizationId` 时带 `X-Organization-ID`；
  3. 204 返回 `undefined`；
  4. 409 或响应体 `code === '23505'` 抛 `RestConflictError`；
  5. 500 抛 `RestRequestError`，且 `status === 500`，消息不泄漏响应正文；
  6. Supabase 未配置时抛 `ApiHttpError(503)`。
- 验证：`npx vitest run apps/api/src/lib/rest-client.test.ts` 红灯。

### 任务 C2：实现 rest-client（GREEN）

- 文件路径：`apps/api/src/lib/rest-client.ts`（新建）
- 要做的：
  - `RestRequestError extends Error { readonly status: number }`、`RestConflictError extends RestRequestError`。
  - `createRestClient(environment, token): { request<T>(path, init?) }`，内部完成 URL 归一化（去尾斜杠）、默认头合并、`X-Organization-ID` 注入、204 处理。
  - 统一用 `/rest/v1/` 前缀拼接；另导出 `authUrl(path)` 供 Auth 端点使用。
- 验证：任务 C1 六个用例全绿。

### 任务 C3：organization-service 改用 rest-client

- 文件路径：`apps/api/src/services/organization-service.ts`
- 要做的：删除文件内 48–76 行的 `databaseUrl` 与 `supabaseRequest`，改为从 `../lib/rest-client` 导入；`createSupabaseOrganizationRepository` 内部统一调用 `client.request(...)`；`OrganizationConflictError` 捕获 `RestConflictError` 后原样抛出，保持上层与现有测试不变。
- 验证：`npx vitest run apps/api/src/services apps/api/src/routes` 全绿（既有 organization 测试不改也应通过）。

### 任务 C4：member-service 的 rpc 与 auth 调用改用 rest-client

- 文件路径：`apps/api/src/modules/members/member-service.ts`
- 要做的：把 `rpc<T>()`、`/auth/v1/invite`、`/auth/v1/recover`、`/auth/v1/user` 四类调用改为走 `createRestClient` 暴露的对应方法（Auth 相关用 `client.authRequest`）。除 service-role 头差异外，其余请求头与错误处理不得发散。
- 验证：`npx vitest run apps/api/src/modules/members` 全绿；`grep -c "await fetch(" apps/api/src/modules/members/member-service.ts` 结果为 0。

---

## 阶段 D：请求治理（幂等 + 限流）

### 任务 D1：幂等存储用测试钉住（RED）

- 文件路径：`apps/api/src/lib/idempotency-store.test.ts`（新建）
- 要做的：用例 4 条：
  1. `set` 后 `get` 返回同一条记录；
  2. 超过 TTL 后 `get` 返回 `null`（用注入的 `now` 推进时间）；
  3. 容量上限（默认 500 条）时淘汰最早写入项；
  4. 未知键返回 `null`。
- 验证：红灯。

### 任务 D2：实现幂等存储 + 中间件（GREEN）

- 文件路径：`apps/api/src/lib/idempotency-store.ts`、`apps/api/src/middleware/idempotency.ts`（均新建）、`apps/api/src/middleware/idempotency.test.ts`（新建）
- 要做的：
  - 存储：`createMemoryIdempotencyStore({ ttlMs = 600_000, maxEntries = 500, now = Date.now })`。**注释标明单实例有效**。
  - 中间件：仅拦截 `POST/PATCH/PUT/DELETE`；读 `Idempotency-Key`，格式须匹配 `^[A-Za-z0-9_-]{8,128}$`，非法则 400 `INVALID_REQUEST`；命中缓存直接 `c.json(record.body, record.status)`；未命中则在 `await next()` 后对 2xx 响应 `clone().json()` 落库（非 JSON 或失败响应不缓存）。
  - 测试：同键二次 POST 只透传一次路由逻辑（用计数器路由验证），且响应体一致；非法键 400；GET 请求带键不生效。
- 验证：`npx vitest run apps/api/src/lib/idempotency-store.test.ts apps/api/src/middleware/idempotency.test.ts` 全绿。

### 任务 D3：限流用测试钉住并实现（RED→GREEN）

- 文件路径：`apps/api/src/lib/rate-limit-store.ts`、`apps/api/src/middleware/rate-limit.ts`、对应 `*.test.ts`（均新建）
- 要做的：
  - 固定窗口计数器：`createFixedWindowRateLimiter({ limit, windowMs, now })`，返回 `check(key) -> { allowed, retryAfterSeconds }`；窗口滚动时重置。
  - 中间件：键取 `cf-connecting-ip`（缺失时回落 `x-forwarded-for` 首段，再回落 `'unknown'`）；超限返回 429，带 `Retry-After` 与 `ERROR_CODES.RATE_LIMITED`；默认 `60 req / 60s`，可通过 `RATE_LIMIT_PER_MINUTE` 覆盖。
  - 测试：第 61 次请求 429；`Retry-After` 为正整数；不同 IP 互不影响。
- 验证：对应测试全绿。

### 任务 D4：接入应用并让前端自动携带幂等键

- 文件路径：`apps/api/src/index.ts`、`apps/api/src/middleware/auth.ts`、`.env.example`、`apps/web/src/lib/api-client.ts`、`apps/web/src/lib/api-client.test.ts`
- 要做的：
  1. `index.ts` 顺序固定为 `requestId → cors → rateLimit → (路由内 auth) → idempotency`，并把顺序写进 `.harness/CONTRACTS.md`；
  2. `Bindings` 增加 `RATE_LIMIT_PER_MINUTE?: string`；
  3. `api-client.ts` 对写方法在单次调用内生成一次 `crypto.randomUUID()` 作为 `Idempotency-Key`，重试复用同一个键（新增测试：重试两次只用一个键，两次调用用不同键）。
- 验证：`npx vitest run apps/api apps/web` 全绿；`.harness/CONTRACTS.md` 含中间件顺序章节。

---

## 阶段 E：可观测性与部署门禁

### 任务 E1：开启 Worker observability

- 文件路径：`wrangler.toml`
- 要做的：在 `[assets]` 之后加
  ```toml
  [observability]
  enabled = true
  head_sampling_rate = 1
  ```
  三个环境（默认/staging/production）共用顶层配置，不重复声明。
- 验证：`pnpm check:deploy` 通过（此时尚未加断言，先确认不破坏既有校验）。

### 任务 E2：把新配置纳入部署门禁

- 文件路径：`scripts/check-deploy-config.ts`、`scripts/check-deploy-config.test.ts`（若不存在则新建）
- 要做的：`configRequirements` 追加 `'[observability]'` 与 `'enabled = true'`；`.env.example` 断言追加 `RATE_LIMIT_PER_MINUTE`。若测试文件已存在则同步补用例，断言缺失 `[observability]` 时报出对应 issue。
- 验证：`pnpm check:deploy` 通过；`npx vitest run scripts` 或既有 deploy 校验测试全绿。

---

## 阶段 F：CI 迁 Gitee Go

### 任务 F1：写 Gitee Go 流水线配置

- 文件路径：`.workflow/ci.yml`（新建 `.workflow/` 目录）
- 要做的：按 Gitee Go `version: '1.0'` 规范编写，结构为
  - `name: udone-ci`、`displayName: udone 质量门禁`
  - `triggers.push.branches.precise: [main]` + `pr.branches` 覆盖待合并分支
  - 单个 stage `quality`，`strategy: fast`，一个 Node step
  - step 的 `goals`（多行 shell）依次执行：`corepack enable` → `corepack prepare pnpm@11.24.0 --activate` → `pnpm install --frozen-lockfile` → `pnpm format:check` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm schema:check` → `pnpm check:deploy`
  - 顶部注释标明：`deps:audit`、`licenses:check`、`db:test` 本阶段不纳入，原因分别是需外网 registry 稳定性、许可证清单需基线、缺 pgTAP 环境（见「残余风险」）。
- 验证：`npx prettier --check ".workflow/**/*.yml"` 通过；本地用 `node -e "require('fs')"` 无法校验语义，故必须在 F2 真跑。

### 任务 F2：在 Gitee 控制台启用并真跑一次（人工检查点）

- 文件路径：无（Gitee 仓库设置）
- 要做的：把 `.workflow/ci.yml` 推到 Gitee，在「流水线」页面确认自动识别、手动触发一次，逐个核对每个 goal 的失败点。常见需修：Node 插件版本不支持 pnpm 11、`corepack` 不存在、缓存目录权限。
- 验证：Gitee Go 上出现一次**全绿**构建记录，并把构建链接/时间写进 `udone/.harness/journal/2026-10-29-p0-hardening.md`。**在拿到全绿记录前，不得勾选本任务，也不得删除 GitHub Actions。**

### 任务 F3：下线失效的 GitHub Actions 并更新文档

- 文件路径：`udone/.github/workflows/ci.yml`（删除）、`udone/ARCHITECTURE.md`、`udone/AGENTS.md`、`.harness/QUALITY_SCORE.md`（如提及 CI）
- 要做的：删除 `.github/workflows/`；在 `ARCHITECTURE.md` 的 CI 章节写明「门禁由 Gitee Go `.workflow/ci.yml` 执行，GitHub Actions 已下线」；`AGENTS.md` 中凡引用 GitHub CI 的位置同步改写。
- 验证：`grep -rn "github/workflows" udone --include=*.md` 无残留引用；`pnpm format:check` 通过。

---

## 阶段 G：文档收口与全量验证

### 任务 G1：把新约束写进契约红线

- 文件路径：`.harness/CONTRACTS.md`
- 要做的：新增三节——「中间件顺序（不可调换）」「跨域白名单规则」「幂等与限流边界（单实例有效，跨实例需 KV/DO）」，并在 checklist 增加：新增写端点必须能接受 `Idempotency-Key`、新增前端域名必须同步 `ALLOWED_ORIGINS`。
- 验证：文档内每个约束都指向可执行入口（测试文件名或门禁命令）。

### 任务 G2：全量门禁 + journal

- 文件路径：`udone/.harness/journal/2026-10-29-p0-hardening.md`（新建）
- 要做的：依次跑 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm check:deploy`、`pnpm schema:check`，把每条实际输出结论写进 journal；记录未覆盖项与原因。
- 验证：以上七条命令全部退出码 0，journal 内含逐条结果。

---

## 残余风险（本轮不假装解决）

1. **pgTAP 无法本地执行**：`supabase` CLI / `docker` / WSL 均不可用。数据库门禁仍靠代码评审 + `schema:check` 静态比对，Task 4 起涉及 migration 的验收必须在此前解决环境。
2. **Gitee Go 免费额度与 Node 版本支持未知**：F2 若因插件版本失败，降级方案是自建 runner 或退回 GitHub 镜像；届时需重新决策，不静默降级。
3. **内存限流/幂等在多实例下不一致**：已在代码与文档标注。真实生效需 KV 或 Durable Object，留待有并发写压力时。
4. **数据库无 TS 类型生成**：SQL 改列不会导致编译失败，只靠出站 `respond()` 运行时兜底。
5. **`admin` 侧跨域与契约消费未验证**：本计划只保证 `udone` 服务端放行，`admin` 的实际域名需在联调时补进 `ALLOWED_ORIGINS`。
