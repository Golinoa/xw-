# 2026-10-05-ops-console-frontend-foundation

## Task

Execute Task 1 only from `.harness/docs/exec-plans/active/2026-10-05-ops-console-implementation.md` in `~admin`.

## Starting state and repository

- The directory contained only the existing project/engineering documents; it had no `.git`, manifests, application sources or lockfile. `udone` was not modified.
- Preserved the existing documents as the initial Git baseline (`ad8b8ef`, `docs: establish ops console project baseline`), then created branch `feat/ops-console-task-1-vben-foundation` for Task 1.
- Existing project files remain in place; Vben files were imported without replacing `AGENTS.md`, `ARCHITECTURE.md`, `DESIGN.md`, `README.md`, `Docs/` or `.harness/`.

## Vben source and imported scope

- Verified the official `vbenjs/vue-vben-admin` `v5.7.0` release tag resolves to commit `63a38dce49ba109f61607994e21ba921d8e970e9` on 2026-10-05. The app package uses workspace `@vben/*` packages and is MIT-licensed; retained the upstream MIT `LICENSE` and copyright notice.
- Imported the shared `packages/`, `internal/`, `scripts/` workspace and the single product application `apps/web-antd`. Did not import other product apps, `playground/`, or the mock backend application.
- The upstream `docs/` directory cannot coexist with this project’s `Docs/` directory on Windows/NTFS because paths are case-insensitive. Kept the product PRD/technical sources unchanged at `Docs/`; the upstream documentation remains available at the pinned commit. This is the only omitted upstream source directory; it is not a workspace package needed by `web-antd`.
- Kept the upstream single `pnpm-lock.yaml`, pnpm workspace structure and root configuration. The imported `.gitignore` ignores `node_modules`, `dist`, local env overrides and build/test output. Reviewed lifecycle scripts: `preinstall` enforces pnpm, `postinstall` builds workspace stubs, and `prepare` installs lefthook hooks. Narrowed `postinstall` to the antd app and required root tooling/config dependencies so unused workspace packages are not built.
- Pinned Node `24.20.0` in `.node-version` (installed locally and permitted by the upstream Node engine range) and pnpm `10.33.4` in the upstream `packageManager` field. Corepack selected pnpm `10.33.4`.

## Demo/mock inventory and disposition

- **Retained temporarily as template scaffolding:** login, registration, code-login, QR-login and password-reset views; `/auth/*`, `/user/info`, `/menu/all` and `/auth/codes` example client paths/types; demo route `src/router/routes/modules/demos.ts`; static dashboard/workbench and Ant Design demo views; generic Vben access/menu/user components.
- **Must be replaced or removed before the real operations entry/API is enabled (Task 3):** demo auth/session and registration flows, mock-shaped auth/user/menu/access API client, `/demos` navigation/views and static dashboard/demo content. Their names and shapes do not define an operations API contract.
- The upstream `internal/vite-config` has a Nitro dev-mock plugin. Its default `apps/backend-mock` package was not imported; the current development mock flag therefore has no imported mock server to serve data. The production `.env` no longer points at `mock-napi.vben.pro`; it uses same-origin `/api` pending a backend-published contract. No API/database/backend work was done.

## Tool installation and validation

- `node --version` → `v24.20.0`; `corepack pnpm --version` → `10.33.4`.
- Final repeatable install command: `corepack pnpm install --filter '@vben/web-antd...' --filter '@vben/vsh...' --filter '@vben/vite-config...' --filter '@vben/eslint-config...' --filter '@vben/oxfmt-config...' --filter '@vben/oxlint-config...' --filter '@vben/stylelint-config...' --filter . --frozen-lockfile` → exit 0, lockfile current, selected 35 of 39 workspace projects, postinstall and lefthook prepare completed. Install uses the upstream `.npmrc` registry mirror. Vben’s `internal/node-utils` stub emitted Node `[DEP0190]` warning because upstream invokes a child process with `shell: true`; it completed successfully.
- `corepack pnpm --filter @vben/web-antd typecheck` → pass.
- `corepack pnpm --filter @vben/web-antd build` → pass; Vite 8.0.13 transformed 7,788 modules and created `apps/web-antd/dist.zip`. Build artifacts are ignored.
- App-source lint commands → pass: `corepack pnpm exec oxfmt --check apps/web-antd` (62 files), `corepack pnpm exec oxlint --threads=2 apps/web-antd`, `corepack pnpm exec eslint apps/web-antd/src --ext .ts,.vue`, and `corepack pnpm exec stylelint 'apps/web-antd/src/**/*.{vue,css,less,scss}' --cache`.
- `corepack pnpm test:unit` → pass, 35 files / 309 tests. Vitest emitted one non-fatal warning that an upstream `vi.mock()` call in `packages/@core/composables/src/__tests__/use-sortable.test.ts` is nested rather than top-level.
- `corepack pnpm lint` → exit 1 at repository-wide Oxfmt check; 10 existing project-document files were listed, including 7 untouched by Task 1. The command formats/lints the entire checkout and provides no path filter. Did not batch-format project documents. App-source formatter and code lints above passed.
- Initial filtered install/build attempts exposed missing app/root tool workspace dependencies; corrected filters based on package manifests and missing `dist` evidence. The final standard frozen install, typecheck and build all passed as listed above.

## Files changed

- Imported Vben source/workspace configuration and retained upstream lockfile/license.
- Updated `package.json` postinstall filter, `.node-version`, `apps/web-antd/.env.production`, `README.md`, `Docs/TECH_SELECTION.md`, `.harness/PROJECT_STRUCTURE.md`, this execution plan, and this journal.

## Boundary and next step

- Task 1 only. No API, database, migration, backend, user/tenant data, CI or deployment changes.
- Full-repository lint remains limited by the listed existing document formatting baseline; preserve those documents for their owners/Task 2 review. Task 2 remains the next allowed frontend task after this commit.

## Decisions, issues, next steps

- Keep Vben demo features isolated as scaffolding and replace them before real operations identity/API integration.
- Maintain the pinned upstream commit and single lockfile. Any upgrade requires repeating license, workspace, engine and build checks.
- Commit hash and final Git status are recorded in the task completion report after commit.
