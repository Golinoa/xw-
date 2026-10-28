# 平台基础与权限骨架实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可部署的旅行社 OMS monorepo 基础，并完成 Auth、组织、角色、租户隔离和共享 API 契约，为后续订单与财务功能提供稳定边界。

**Architecture:** 使用 Vue 3 + Vite + TypeScript + Element Plus 构建前端，Cloudflare Workers + Hono 提供 API，Supabase PostgreSQL/Auth/RLS 提供身份和数据隔离。前后端通过 `packages/contracts` 共享请求、响应、错误码和权限类型；业务写入先经过 API，数据库策略作为第二层保护。

**Tech Stack:** pnpm workspace、TypeScript、Vue 3、Vite、Element Plus、Hono、Wrangler、Supabase CLI、PostgreSQL、Vitest、Playwright。

> 历史说明（2026-10-04）：本计划记录平台骨架实施时的前端组件库基线。当前选型已调整为 Ant Design Vue，后续开发以 `Docs/TECH_SELECTION.md` 和 `.harness/FRONTEND.md` 为准；本计划中的已完成任务和当时验证记录保留原样。

**Spec:** `Docs/REQUIREMENTS.md`、`Docs/TECH_SELECTION.md`、`Docs/REPLICATION_SPEC.md`

## Global Constraints

- API 后端使用 TypeScript + Hono，运行在 Cloudflare Workers。
- 数据库迁移、RLS、约束和事务函数统一使用 Supabase CLI SQL migration。
- 前端不得持有 service role 密钥；service role 只存在于 Worker Secret。
- 所有租户数据必须经过组织/租户上下文和 PostgreSQL RLS 双重保护。
- 测试使用虚构数据，不写入目标站真实账号、Cookie、Authorization 或个人资料。
- 本阶段只建立基础设施和权限骨架，不实现订单、财务和 CRM 业务页面。

## Review Focus

- 未登录请求访问受保护 API：必须返回统一 `AUTH_REQUIRED`，不能返回数据库错误。
- 用户属于两个组织时切换组织：请求上下文和 RLS 必须只作用于当前组织。
- 普通操作员读取其他组织数据：API 和数据库均必须拒绝。
- service role 配置缺失或误放入前端构建变量：构建检查必须失败。
- 重复提交登录回调或组织切换请求：必须是幂等或返回明确冲突，不产生重复成员记录。

### Task 1: 建立 monorepo 和开发命令

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `apps/web/package.json`
- Create: `apps/api/package.json`
- Create: `packages/contracts/package.json`
- Create: `apps/web/src/main.ts`
- Create: `apps/api/src/index.ts`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Test: `tests/tooling/workspace.test.ts`

**Interfaces:**
- Produces workspace scripts `dev`, `typecheck`, `test`, `build` and packages `@erp/web`, `@erp/api`, `@erp/contracts`.
- `apps/api/src/index.ts` exports a Hono app for local tests and Wrangler entrypoint.

- [x] **Step 1: Write the failing workspace smoke test**

  Assert that package manifests, workspace package names, and the Hono app export exist.

- [x] **Step 2: Run the smoke test and verify it fails**

  Run: `pnpm vitest run tests/tooling/workspace.test.ts`

  Expected: FAIL because the workspace files do not exist.

- [x] **Step 3: Create the workspace and minimal app entrypoints**

  Configure pnpm scripts, strict TypeScript, Vite, Wrangler and a Hono `GET /api/health` route. Keep environment values in `.env.example` only.

- [x] **Step 4: Run typecheck, test, and build**

  Run: `pnpm typecheck && pnpm vitest run && pnpm build`

  Expected: PASS for all packages.

- [x] **Step 5: Commit**

  Commit message: `chore: scaffold oms monorepo`

### Task 2: 建立共享契约、错误码和权限类型

**Files:**
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/permissions.ts`
- Create: `packages/contracts/src/http.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/*.test.ts`

**Interfaces:**
- `AuthContext`: `{ userId: string; organizationId: string; role: "admin" | "operator" | "finance"; sessionId: string }`.
- `ApiErrorBody`: `{ code: string; message: string; requestId: string; details?: unknown }`.
- Permission constants include `organization.read`, `member.manage`, `settings.manage`, `audit.read`.
- `ApiResponse<T>` distinguishes success payload from `ApiErrorBody`.

- [x] **Step 1: Write failing tests for exact types and error codes**

  Cover `AUTH_REQUIRED`, `FORBIDDEN`, `ORG_CONTEXT_REQUIRED`, `VALIDATION_ERROR`, `CONFLICT`, and `INTERNAL_ERROR`.

- [x] **Step 2: Run the contract tests and verify they fail**

  Run: `pnpm vitest run packages/contracts/src`

- [x] **Step 3: Implement the shared types and constants**

  Export all types from `packages/contracts/src/index.ts`; use string literal unions instead of duplicated string constants.

- [x] **Step 4: Run contract tests and typecheck**

  Run: `pnpm vitest run packages/contracts/src && pnpm typecheck`

  Expected: PASS.

- [x] **Step 5: Commit**

  Commit message: `feat: add shared api contracts`

### Task 3: 建立 Supabase schema、迁移和 RLS 骨架

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/20261003000000_identity.sql`
- Create: `supabase/migrations/20261003000001_rls_helpers.sql`
- Create: `supabase/tests/identity_rls.sql`
- Create: `supabase/seed.sql`
- Test: `tests/database/identity-rls.test.ts`

**Interfaces:**
- Tables: `organizations`, `organization_members`, `profiles`, `audit_events`.
- Function: `public.current_organization_id() returns uuid`.
- Function: `public.has_permission(permission text) returns boolean`.
- Membership uniqueness: `(organization_id, user_id)`.
- Every exposed table enables RLS and has explicit grants/policies.

- [x] **Step 1: Write failing database policy tests**

  Assert that an authenticated member can read its organization, a non-member cannot, and a member cannot change `organization_id` through an update.

- [x] **Step 2: Run the database tests and verify the schema is absent**

  Run: `supabase test db`

  Expected: FAIL because the migration and helper functions do not exist.

- [x] **Step 3: Implement the identity schema and RLS policies**

  Use UUID primary keys, foreign keys to `auth.users`, timestamp defaults, restrictive grants, and policies based on the JWT user ID plus selected organization context. Do not add business tables in this task.

- [x] **Step 4: Run migrations and database tests**

  Run: `supabase db reset && supabase test db`

  Expected: PASS with no policy failures.

  本地真实 PostgreSQL 验收（2026-10-03）：WSL Ubuntu native runtime / Supabase CLI 2.119.0；`supabase db reset` 应用了两份时间戳迁移和 seed，`supabase test db` 的 14 个 pgTAP 用例全部通过。

- [x] **Step 5: Commit**

  Commit message: `feat: add identity schema and tenant rls`

  后续迁移命名修复提交：`7782b93 fix: use timestamped Supabase migrations`。

### Task 4: 实现 Worker Auth 中间件和统一错误处理

**Files:**
- Create: `apps/api/src/middleware/request-id.ts`
- Create: `apps/api/src/middleware/auth.ts`
- Create: `apps/api/src/middleware/error-handler.ts`
- Create: `apps/api/src/routes/health.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/middleware/*.test.ts`

**Interfaces:**
- `requireAuth(): MiddlewareHandler` rejects missing/invalid bearer tokens with `AUTH_REQUIRED`.
- `requirePermission(permission: Permission): MiddlewareHandler` rejects insufficient permissions with `FORBIDDEN`.
- Every response includes `X-Request-Id`; error bodies follow `ApiErrorBody`.

- [x] **Step 1: Write failing middleware tests**

  Cover missing token, malformed token, valid test token, denied permission, and preservation of request ID.

- [x] **Step 2: Run middleware tests and verify they fail**

  Run: `pnpm vitest run apps/api/src/middleware`

- [x] **Step 3: Implement middleware with injected Auth verifier**

  Keep Supabase client creation behind an environment interface so tests can inject a fake verifier. Never log the raw token.

- [x] **Step 4: Run middleware tests and API typecheck**

  Run: `pnpm vitest run apps/api/src/middleware && pnpm typecheck`

  Expected: PASS.

- [x] **Step 5: Commit**

  Commit message: `feat: add worker auth middleware`

### Task 5: 实现组织上下文和成员管理 API

**Files:**
- Create: `apps/api/src/routes/organizations.ts`
- Create: `apps/api/src/services/organization-service.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/organizations.test.ts`

**Interfaces:**
- `GET /api/me` returns the current user and memberships.
- `POST /api/organizations` creates an organization and owner membership in one transaction.
- `POST /api/organizations/:id/switch` validates membership and returns the selected organization context.
- `GET /api/organizations/:id/members` requires `member.manage` or `organization.read`.

- [x] **Step 1: Write failing route tests**

  Assert owner creation, membership rejection, duplicate membership conflict, and cross-organization access denial.

- [x] **Step 2: Run route tests and verify they fail**

  Run: `pnpm vitest run apps/api/src/routes/organizations.test.ts`

- [x] **Step 3: Implement service and routes**

  Use database transactions for organization plus owner membership. The API must set organization context explicitly and rely on RLS for final row filtering.

- [x] **Step 4: Run route, database, and contract tests**

  Run: `pnpm vitest run && supabase test db`

  Expected: PASS.

- [x] **Step 5: Commit**

  Commit message: `feat: add organization context api`

### Task 6: 建立前端登录、组织切换和权限路由骨架

**Files:**
- Create: `apps/web/src/lib/supabase.ts`
- Create: `apps/web/src/stores/auth.ts`
- Create: `apps/web/src/router/index.ts`
- Create: `apps/web/src/layouts/AppLayout.vue`
- Create: `apps/web/src/views/LoginView.vue`
- Create: `apps/web/src/views/HomeView.vue`
- Test: `apps/web/src/stores/auth.test.ts`
- Test: `tests/e2e/auth.spec.ts`

**Interfaces:**
- Auth store exposes `session`, `user`, `memberships`, `currentOrganization`, `signIn`, `signOut`, and `switchOrganization`.
- Protected routes redirect unauthenticated users to `/login`.
- UI never imports or receives a service role key.

- [x] **Step 1: Write failing store and E2E tests**

  Cover redirect without session, successful login fixture, sign-out, and organization switch updating API headers/context.

- [x] **Step 2: Run tests and verify they fail**

  Run: `pnpm vitest run apps/web/src/stores/auth.test.ts` and `pnpm playwright test tests/e2e/auth.spec.ts`

- [x] **Step 3: Implement Supabase client, auth store, router guard, and layout**

  Use public Supabase URL and publishable key only. Keep business pages out of this task.

- [x] **Step 4: Run frontend tests and production build**

  Run: `pnpm vitest run apps/web/src/stores/auth.test.ts && pnpm playwright test tests/e2e/auth.spec.ts && pnpm build`

  Expected: PASS with a deployable static asset bundle.

- [x] **Step 5: Commit**

  Commit message: `feat: add frontend auth shell`

### Task 7: 配置 Cloudflare Worker 部署和真实链路验收

**Files:**
- Create: `wrangler.toml`
- Create: `apps/api/src/env.d.ts`
- Create: `scripts/check-deploy-config.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Test: `tests/smoke/deployed-stack.spec.ts`

**Interfaces:**
- Worker bindings include Supabase URL, publishable key, and server-side secret without committing values. Object storage is excluded from this plan until the `R-FILE-01` trigger is met.
- `GET /api/health` returns version, request ID, and Supabase dependency status without exposing secrets.
- Deploy command is `pnpm wrangler deploy` after a successful build.

- [x] **Step 1: Write failing deploy-config checks**

  Assert required variable names, absence of secret values in frontend output, and health response shape.

- [x] **Step 2: Run the checks and verify configuration is incomplete**

  Run: `pnpm tsx scripts/check-deploy-config.ts`

  Expected: FAIL until bindings and deployment configuration exist.

- [x] **Step 3: Add Wrangler configuration and health route deployment wiring**

  Use environment-specific Supabase variables and deployment settings. Do not configure an object-storage binding or storage health dependency while the file workflow is deferred. Do not commit production tokens.

- [x] **Step 4: Run local and deployed smoke tests**

  Run: `pnpm build && pnpm wrangler dev` followed by `pnpm playwright test tests/smoke/deployed-stack.spec.ts`; after deployment, repeat against the actual Worker URL.

  Expected: SPA delivery, Supabase health, login callback, organization context, and RLS denial are observable in real requests. File storage is not a Task 7 acceptance gate.

  验收记录（2026-10-03）：`pnpm build`、`pnpm check:deploy`、`pnpm typecheck` 与 `pnpm test` 通过（14 个文件、47 项）。部署 `udone-oms-staging` 到 `https://udone-oms-staging.qq151536422.workers.dev`；真实 Worker health 返回 200 且 Supabase 为 available，未认证 `/api/me` 返回 401。远端 Playwright 3 项全部通过，覆盖 SPA/health、未认证错误契约、真实登录、组织选择和非成员组织 RLS 拒绝。Supabase 仅应用三份待处理迁移，无 seed/reset。因本地 Supabase runtime 未启动，本地 DB 容器测试仍未验证；存储不属于本任务门槛。

- [x] **Step 5: Commit**

  Commit message: `chore: configure worker deployment smoke checks`

## Self-Review Checklist

- [ ] Every requirement in `TECH_SELECTION.md` sections 5–10 is represented by a task or explicitly deferred.
- [ ] No task writes business tables for orders or finance before identity/RLS passes.
- [ ] Shared types and route signatures are consistent across Tasks 2, 4, 5, and 6.
- [ ] Database policy tests cover cross-tenant denial and organization context changes.
- [ ] Real deployed request/response evidence is collected before calling the foundation complete.
