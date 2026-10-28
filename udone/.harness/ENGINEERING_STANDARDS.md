# Engineering workflow standards

> 状态：项目规范基线　|　适用范围：pnpm workspace、本地开发、CI、依赖和发布交付

## 1. Workspace and commands

- Use the repository package manager `pnpm@11.24.0` and committed `pnpm-lock.yaml`; do not mix npm/yarn lockfiles or install dependencies at the workspace root without a workspace need.
- Keep Web, API and shared contracts inside their existing workspace packages. Put dependencies in the package that imports them and use workspace references for internal packages.
- Current root commands are `pnpm dev`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check:deploy` and `pnpm smoke`. Preserve their purpose and update docs when scripts change.
- Before a code change is ready for review, run the applicable typecheck, focused tests and build. Run deploy/smoke checks when configuration or runtime boundaries change; run database tests for RLS/schema changes.

## 2. Configuration and secrets

- Commit safe templates such as `.env.example`; ignore local secret files and never copy secret values into logs, journals, generated artifacts or test output.
- Keep frontend variables public by design; service credentials and signing keys belong only in Worker secrets or the approved server secret store.
- Validate required environment bindings at startup/health boundaries and provide safe failure messages. Do not silently substitute production-like credentials or endpoints.
- Local, staging and production targets must be explicit. A deployment command must name the environment and must not infer a remote target from a developer's shell state.

## 3. Dependency and license review

- Prefer existing platform and workspace capabilities. Before adding a dependency, record why built-in code is insufficient, package ownership, runtime/bundle impact, maintenance state, license and known security advisories.
- Keep the lockfile in the same change as manifest updates. Avoid unpinned remote scripts, abandoned packages and duplicate libraries serving the same role.
- All-severity lockfile audit is `pnpm deps:audit` (npm registry). License inventory is `pnpm licenses:check`; global expressions pass from the exact list in `scripts/license-policy.json`, while exceptions match a precise package/version/license, scope, approver, and decision date. Approved development-tool exceptions are rejected if they enter the production dependency tree. Pending items block CI.

## 4. CI and quality gates

- Local gates are `pnpm format:check`, `pnpm format:sql:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check:deploy`, `pnpm deps:audit`, `pnpm licenses:check`, `pnpm secrets:check`, `pnpm secrets:canary:check`, `pnpm schema:check`, and `pnpm db:test`. `.github/workflows/ci.yml` runs these on pull requests and pushes to `main`; pgTAP uses a disposable local Supabase stack, with no production credentials or remote writes.
- Recommended merge gate: typecheck, unit/contract/API tests and build for every code change; database tests for schema/RLS changes; E2E for critical user flows; deployment checks for Worker/config changes.
- Add CI only when the workflow can run without production credentials or shared mutable data. Keep external staging acceptance separate and report its evidence explicitly.
- Formatting/lint tooling must be selected, configured and scripted before it becomes a required gate; see [code writing standards](CODE_STANDARDS.md).

## 5. Release and migration workflow

- Keep changes reviewable and scoped. Review generated files as outputs, not sources; regenerate them from their authoritative source rather than editing by hand.
- Before deployment, verify branch/commit, target environment, build output, secrets by variable name (never values), pending migrations and rollback/recovery plan.
- For database changes, follow [database migration and deployment rules](DATABASE_STANDARDS.md). For public release or production claims, use the active plan's real environment evidence and do not substitute local checks.
- Preserve logs and journal entries with command outcomes while redacting tokens, personal information and payment data.

## 6. Current automation gaps

- GitHub branch protection is a separate repository setting and is not enabled by adding workflow YAML. Require the CI `checks` job before merging to `main`, require an up-to-date branch, and disallow force-push/bypass; repository-owner configuration and readback remain external to this checkout.

## Related standards

- [Code writing standards](CODE_STANDARDS.md)
- [Testing standards](TESTING_STANDARDS.md)
- [Security rules](SECURITY.md)
- [Reliability rules](RELIABILITY.md)
- [Quality and review standard](QUALITY_SCORE.md)
