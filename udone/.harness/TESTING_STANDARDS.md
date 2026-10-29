# Testing standards

> 状态：项目规范基线　|　适用范围：TypeScript/Vue、Hono API、PostgreSQL RLS 和浏览器流程

## 1. Test by risk and layer

| Test level | Use for | Current location / command |
|---|---|---|
| Unit/contract | Pure domain rules, validation, mapping, permissions, errors | Co-located `*.test.ts`; `pnpm test` |
| API integration | Route, middleware, auth, request validation, error/permission behavior | `apps/api/src/**/*.test.ts`; `pnpm test` |
| Database | Constraints, grants, RLS, transaction/RPC and tenant isolation | `supabase/tests/*.sql`; `pnpm db:local:verify`（原生 PostgreSQL + 兼容层）；有 Supabase CLI 时用 `pnpm db:test` |
| HTTP integration | Service → rest-client → PostgREST → RPC/RLS: RPC parameter names, returned column names, SQLSTATE→HTTP mapping, pagination `Content-Range` | `tests/integration/*.test.ts`; `pnpm db:local:http` |
| Browser E2E | Critical user workflows through the web app | `tests/e2e/*.spec.ts`; `pnpm exec playwright test --config playwright.config.ts` |
| Worker smoke | Deployment shape, health, auth/session and real integration boundaries | `tests/smoke/*.spec.ts`; `pnpm smoke` |

Choose the fastest level that proves the behavior; use the real database/runtime when the requirement depends on PostgreSQL policies, Worker bindings or browser navigation.

The repository Vitest gate is `pnpm test`; targeted tests use `pnpm vitest run <path>`. Discovery is limited to `apps/`, `packages/`, and `tests/`, excluding managed `.worktrees/`. Vue component behavior tests do not yet have a component mounting library; use the closest API/contract test until a UI behavior change justifies introducing one. Playwright smoke remains `pnpm smoke` and uses its explicit environment configuration.

## 2. Required scenarios

- For changed behavior, cover the normal case, invalid input, permission denial, missing/expired context, not-found/conflict, and relevant dependency failure.
- Tenant-scoped features test a valid member, another organization, and a non-member. Database isolation requires database/RLS assertions, not only a mocked API test.
- Financial and approval changes cover duplicate submission, concurrent conflict, authorization/self-approval rules, rollback and audit record behavior as required by the confirmed workflow.
- Frontend behavior covers loading, empty, error, permission-denied, validation and destructive confirmation states when those states apply.
- Tests use deterministic fictional data. Never depend on real customer, traveler, supplier, payment or production data.

## 3. Test quality

- Keep tests deterministic, isolated and explicit about their environment. Avoid arbitrary sleeps; wait on a meaningful state or controlled clock.
- Prefer assertions on externally visible behavior and invariant boundaries over implementation details.
- Reset/rollback local database fixtures within the test boundary. Do not mutate shared staging/production data as part of routine test runs.
- Do not skip a required security or failure case to make a suite pass; explain environment-only gates and retain them as unverified.
- A test name states the behavior. Fixtures must be minimal and must not contain credentials or real personal data.

## 4. Coverage and evidence

- No repository-wide coverage percentage is currently approved or configured. Do not invent a numeric threshold or imply that a command enforces one.
- Until coverage reporting/thresholds are adopted, review changed branches and risk cases explicitly. Any future threshold must name the metric, scope, exclusions and enforcement command.
- Report the exact command, environment, pass/fail count and any skipped/unavailable integration gate. A typecheck/build does not prove runtime behavior; mocked tests do not prove RLS.
- Production or release claims require the environment-specific smoke, migration, concurrency and recovery evidence required by the active plan.

## Related standards

- [API and permission standards](API_STANDARDS.md)
- [Database standards](DATABASE_STANDARDS.md)
- [Quality and review standard](QUALITY_SCORE.md)
- [Engineering workflow](ENGINEERING_STANDARDS.md)
