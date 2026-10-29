# 2026-10-29 P0 架构加固（CORS / 令牌 / REST 出口 / 请求治理 / CI）

分支：`feat/p0-architecture-hardening`
计划：`Docs/superpowers/plans/2026-10-29-p0-architecture-hardening.md`
前置提交：`7ba3eb7 feat(udone): contract-first zod pipeline with drift guards`

## 决策记录

| 议题 | 结论 | 依据 |
|---|---|---|
| 本轮范围 | P0 架构加固全量 | 用户确认；不依赖外部账号，本地可全绿验证 |
| CI 归属 | Gitee Go（`.workflow/*.yml`） | 远端一直是 Gitee 私有库，GitHub Actions 从未执行 |
| 令牌存储 | `sessionStorage` | 关闭标签页即失效，收窄 XSS 窗口；httpOnly BFF 另立项 |

## 改动

### 阶段 A：CORS

- 新增 `apps/api/src/middleware/cors.ts`：`parseAllowedOrigins` 精确匹配、去尾斜杠、
  **过滤 `*`**；`corsMiddleware` 包装 `hono/cors`，`credentials: false`（Bearer 无需凭据）。
- 接入 `apps/api/src/index.ts`，位置在 `requestId` 之后、路由之前，保证预检不经鉴权。
- `ALLOWED_ORIGINS` 同步落到 `env.d.ts`、`ApiEnvironment.Bindings`、`.env.example`、
  `scripts/check-deploy-config.ts`（含「不得为 `*`」断言）。
- 测试 `cors.test.ts` 8 例：允许来源回显原值而非 `*`、白名单外无 CORS 头、
  预检 204 且允许 `Authorization`/`X-Organization-ID`/`Idempotency-Key`、
  未配置时全拒、不带 `allow-credentials`。

### 阶段 B：令牌

- `apps/web/src/lib/supabase.ts`：`auth.storage` 改为 `globalThis.sessionStorage`。
- 测试 `supabase.test.ts` 3 例：storage 为 sessionStorage、持久/刷新开关注释、
  未配置时导出 `null`。

### 阶段 C：统一 REST 出口

- 新增 `apps/api/src/lib/rest-client.ts`：`createRestClient(env, token)` 提供
  `rest<T>()`（PostgREST）与 `auth()`（Supabase Auth，返回原始 Response）。
  统一 URL 归一化、`apikey`/`Authorization`/`X-Organization-ID` 注入、204 处理、
  409 与 `23505` → `RestConflictError`、其他非 2xx → `RestRequestError`（**不回显上游 body**）、
  未配置 → `ApiHttpError(503)`。
- `organization-service.ts` 删除内联 `databaseUrl`/`supabaseRequest`，改走 client；
  `RestConflictError` → `OrganizationConflictError` 保持上层语义。
- `member-service.ts` 的 `rpc` 与 `/auth/v1/{invite,recover,user}` 三处改走 client。
- 结果：`await fetch(` 在 `member-service.ts`、`organization-service.ts` 计数均为 0。
- 测试 `rest-client.test.ts` 9 例。

### 阶段 D：幂等与限流

- `lib/idempotency-store.ts`：TTL + 容量淘汰（默认 600s / 500 条），注释标明
  **单 Worker isolate 有效**。测试 5 例。
- `middleware/idempotency.ts`：仅写方法、键格式 `^[A-Za-z0-9_-]{8,128}$`、
  2xx JSON 才落库、回放加 `Idempotent-Replay: true`。测试 6 例。
- `lib/rate-limit-store.ts` + `middleware/rate-limit.ts`：固定窗口，默认 60/min，
  `RATE_LIMIT_PER_MINUTE` 覆盖，键取 `cf-connecting-ip`，回落 `x-forwarded-for` 首段。
  超限 429 + `Retry-After` + `RATE_LIMITED`。测试 9 例。
- `packages/contracts/src/errors.ts` 新增 `RATE_LIMITED`（契约快照测试同步更新）。
- 前端 `api-client.ts`：写方法在单次 `call` 内生成一次 `Idempotency-Key`，重试复用；
  新增 `RATE_LIMITED` 中文文案。测试 +3 例。
- `index.ts` 固定顺序：`requestId → cors → rateLimit → idempotency → routes`。

### 阶段 E：可观测性

- `wrangler.toml` 新增 `[observability] enabled = true / head_sampling_rate = 1`。
- `check-deploy-config.ts` 抽出 `WRANGLER_REQUIREMENTS` / `WORKER_ENV_VARIABLES` /
  `ENV_EXAMPLE_VARIABLES` 三个导出常量并加入新校验：
  `[observability]` 必须存在、公共配置必须有可用默认值、`ALLOWED_ORIGINS` 禁通配。
- **未加 cron**：当前无周期性作业，按 YAGNI 留到 Task 5 结算/通知真正需要时再配。

### 阶段 F：CI（未完成，见下）

- 新增 `.workflow/ci.yml`（Gitee Go `version: '1.0'`），单 stage `quality`，
  `npmbuild@1` 依次跑 `pnpm install --frozen-lockfile` → format:check → lint →
  typecheck → test → build → schema:check → check:deploy。
- `.workflow/**/*.yml` 纳入 prettier 范围。
- 依据：Gitee Go 已支持 Node v8.16–v25.4 与 PNPM 10–11，故 `pnpm@11.24.0` 可用。

## 门禁结果（实际执行）

| 命令 | 结果 |
|---|---|
| `pnpm format:check` | 通过（含 `.workflow`） |
| `pnpm lint`（含 CSS token 检查） | 通过 |
| `pnpm typecheck` | 通过（api + web） |
| `pnpm test` | **136 passed / 28 files**（本轮前 91） |
| `pnpm build` | 通过（web 1,617.77 kB / gzip 501.36 kB，既有体积告警未处理） |
| `pnpm check:deploy` | 通过 |
| `pnpm schema:check` | 通过（5 migrations） |

未跑：`deps:audit`、`licenses:check`（需稳定访问 npm registry / 许可证基线）、
`db:test`（缺 pgTAP 环境）。

## 未完成与阻塞

1. **F2：Gitee Go 首次真跑未执行**。需要在 Gitee 仓库「流水线」页面启用
   `.workflow/ci.yml` 并手动触发一次，确认 `npmbuild@1` 的 `nodeVersion: '24'`
   与 `pnpm@11.24.0` 组合可用。**在拿到全绿构建记录前，CI 视为「未生效」。**
2. **F3：未删除 `.github/workflows/ci.yml`**。按计划纪律，托管 CI 未跑通前不删，
   避免出现「门禁已下线、替代品还没工作」的裸奔窗口。
3. **`ARCHITECTURE.md` 无 CI 章节**，计划中「改写 ARCHITECTURE 的 CI 描述」无对象，
   待 F2 完成后新增「持续集成」一节。

## 已知技术债（本轮刻意未做）

- 幂等/限流为单 isolate 内存态，跨实例不一致；资金链路（Task 5/6）前需换 KV/DO。
- 数据库仍无生成 TS 类型，SQL 改列不会导致编译失败。
- 令牌仍在浏览器可读存储，httpOnly BFF 未立项。
- 分页/排序/过滤契约未定，留待 Task 4。
