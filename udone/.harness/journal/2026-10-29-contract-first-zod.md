# 2026-10-29 契约先行：zod 单一真源与四层漂移守卫

## 今日完成

- 建立跨端契约单一真源：`packages/contracts/src` 全部改为 zod schema，类型一律 `z.infer`；
  新增 `health.ts`、`organizations.ts`、`routes.ts`；`errors.ts`/`permissions.ts`/`auth.ts` 由 interface 改为 schema 派生。
- 新增 `ROUTES` 路由注册表（method/path/request/response），8 个既有端点全部登记；路由实现改用 `ROUTES.x.path`。
- 删除 `ApiResponse<T>` 信封死类型（全仓无任何实现使用），响应形态固定为「成功=裸资源体，失败=扁平 `ApiErrorBody`」。
- 新增 `apps/api/src/lib/contract.ts`：`parseJson` / `parseParams` / `parseQuery` / `respond`，出站数据用同一 schema 校验。
- 重构 `routes/health.ts`、`routes/organizations.ts`、`modules/members/routes.ts` 全部走新 helper。
- 新增 `apps/web/src/lib/api-client.ts`：按 route key 调用、自动附加令牌与 `X-Organization-ID`、
  请求前 schema 自检、响应 schema 解析、错误码映射中文、4xx 不重试 / 5xx 最多 3 次、401 换令牌重试一次。
- `stores/auth.ts` 5 处调用全部改走 api client，本地 `Membership` 类型改为契约类型；
  修正旧实现按 `body.error?.message` 解析错误体（服务端返回的是扁平 `body.message`，导致永远显示「请求失败 (400)」）的缺陷。
- 消除 16 处 `../../../../packages/contracts/src` 深路径导入，`packages/contracts` 补 `exports`/`types`/`sideEffects`。
- 新增守卫测试：`route-parity`（ROUTES ↔ Hono 双向对账）、`response-guard`（出站违例/字段剥离）、
  `api-client.test.ts`（7 例：解析、路径参数、请求自检、错误映射、重试策略、缺令牌）。测试 74 → 91。
- 新增 `.harness/CONTRACTS.md`（红线 13 条 + 四层守卫表 + 方案评估 + 新增端点 checklist），
  更新 `API_STANDARDS.md`、`ARCHITECTURE.md`、`DOCUMENT_MAP.md`、`README.md`、`AGENTS.md` 启动必读清单。
- ESLint 增加两条阻断规则：禁止深路径导入契约源码；`routes/**`、`modules/**` 禁止 `context.json()`。

## 关键决策

- **选 zod-first，不选 OpenAPI-first / tRPC / 只靠 DB 生成类型**。理由与对比表写入 `CONTRACTS.md` 附录 A：
  Admin 是独立前端跨仓消费同一 Hono API，tRPC 会堵死这条路；OpenAPI codegen 对单人维护不划算；
  DB 生成类型管不到 HTTP 边界。
- **不做 success/data 信封**。4 个已上线端点、全部 API 测试与 E2E 都是裸资源体，保留一个没人实现的
  `ApiResponse<T>` 只会持续误导两端；要改必须是一次显式兼容迁移。
- **`respond()` 出站校验 fail closed（500）而不是降级放行**。宁可本地/联调时立刻炸，也不要把漂移字段静默送到前端。
- **zod 统一从 `@erp/contracts` 取**，apps 不单独装 zod，保证全仓一份实例。
- 路径参数 schema 暂用 `z.string().min(1)` 而非 `z.uuid()`：测试夹具使用 `org-alpha` 这类短标识，
  收紧会逼着把夹具改成随机 uuid、牺牲可读性；已在代码注释里标注收紧条件。

## 遇到的问题

- 根目录 `tests/**` 无法解析 `hono` 与 `@erp/contracts`（pnpm 严格 node_modules，根包没有这两个依赖）。
  守卫测试因此放在 `apps/api/src/contracts/`，与受保护对象同包。
- `pnpm lint` 与 `pnpm format:check` 在改动前就是红的（AuthFlow.vue 两处裸色值不在
  `legacyRawColorAllowance` 白名单；`tests/e2e/member-onboarding.spec.ts` 未格式化；`auth.ts`
  存在未使用的 `catch (cause)`）。已一并修掉：色值改用 `var(--color-canvas)` / `var(--color-surface)` /
  `var(--color-border-subtle)`（与 AppLayout、LoginView 一致，`applyCssTokens()` 运行时注入），
  其余为纯格式化。
- `pnpm build` 仍有 1.6 MB 主包告警（gzip 501 kB），属既有问题，未在本任务扩展优化。

## 下一步计划

- 数据库 schema → TS 类型：`supabase gen types typescript` 产出 `packages/contracts/src/db.ts`，
  并让 `schema:check` 同时校验 DB 类型与 migration 一致。**前置条件**：本机需 Supabase CLI 或 Docker，
  当前两者都不可用（WSL 被安全策略拦截），因此未动。
- 第一个列表功能（Task 4 主数据）落地时一次性定死分页/排序/过滤契约，回填 `CONTRACTS.md` §8.4。
- 错误码 ↔ HTTP 状态的映射目前是约定，后续可在 `ApiHttpError` 上加类型约束。
- 待用户决定是否将本轮改动提交（当前工作区有未提交改动）。
