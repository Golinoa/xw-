# 2026-10-05 Ops Console Frontend Quality Gates

## Scope and starting state

- Executed Task 2 only from `.harness/docs/exec-plans/active/2026-10-05-ops-console-implementation.md` in `~admin`.
- Starting commit: `f8de6e493b497b6006f2aa6285e24daa1b6b14a6` (`feat/ops-console-task-1-vben-foundation`). The `~admin` worktree was clean before changes. No Git remote is configured in this checkout; `udone` was not modified.
- Reviewed the imported Vben formatter/linter/test scripts, `.github/workflows/ci.yml`, existing deploy workflow gates, the shared setup-node composite action, root manifests/lockfile, and project engineering/testing/security/reliability standards.

## Decisions and changes

- Fixed Node.js to `24.20.0` and pnpm to `10.33.4` in package engine constraints; enabled `engine-strict`; `preinstall` and CI startup call `scripts/quality/check-toolchain.mjs`. Mismatches are checked by `toolchain-policy.mjs`.
- Added root commands for format, app-source Oxlint/ESLint/Stylelint, `web-antd` typecheck, Vben unit tests, antd build, lockfile audit, license policy, secret scan, built-file secret inspection, aggregate quality and negative gate verification.
- Updated the pre-commit hook to run the app-scoped lint, code/config format check and app typecheck. This replaces the imported full-repository lint hook that fails on the already-recorded Markdown baseline; no Markdown files were reformatted.
- Added pinned development-only `secretlint@13.0.7`, `@secretlint/secretlint-rule-preset-recommend@13.0.7`, and `license-checker-rseidelsohn@5.0.1`. The lockfile was updated; no runtime app dependency was added.
- Added `.harness/license-policy.json`: permissive SPDX expressions are allowlisted; 15 exact-version exceptions include reason and review date; unexpected licenses, license changes and stale exceptions fail. The checker scanned installed packages and did not include private packages.
- Added `.github/workflows/frontend-quality.yml`: `pull_request` plus manual dispatch, read-only `contents` permission, exact tool versions, filtered frozen install, local quality command, no `secrets.*` reference or declared ambient env block, and a three-day `web-antd` PR artifact uploaded only after all gates pass. No staging/production deployment, database mutation or production secret is configured in this workflow.
- Recorded required branch check `Frontend Quality / frontend-quality`; enabling branch protection and obtaining a hosted PR run remain code-host settings/evidence.
- Updated `.harness/ENGINEERING_STANDARDS.md` and `.harness/TESTING_STANDARDS.md`. Existing full-repository Markdown format issues were not changed; `format:check` covers code/config extensions and excludes Markdown.

## Verification evidence

Toolchain: Node.js `24.20.0`, pnpm `10.33.4`.

| Command | Result |
|---|---|
| `corepack pnpm install --filter '@vben/web-antd...' --filter '@vben/vsh...' --filter '@vben/vite-config...' --filter '@vben/eslint-config...' --filter '@vben/oxfmt-config...' --filter '@vben/oxlint-config...' --filter '@vben/stylelint-config...' --filter . --frozen-lockfile` | Pass; lockfile current; 35/39 workspace projects selected; toolchain check ran in `preinstall`. |
| `corepack pnpm run format:check` | Pass; 974 matched source/config files in standalone run; no Markdown formatting changes. |
| `corepack pnpm run lint:check` | Pass; Oxlint, ESLint and Stylelint for the selected app. |
| `corepack pnpm run check:type` | Pass; `@vben/web-antd` Vue typecheck. |
| `corepack pnpm run test:unit` | Pass; 35 files, 309 tests. Existing Vben nested `vi.mock()` warning remains non-fatal. |
| `corepack pnpm run build:antd` | Pass; 11 Turbo tasks; Vite build completed; generated `apps/web-antd/dist.zip` (1,157,746 bytes). |
| `corepack pnpm run quality:licenses` | Pass; 1,515 installed packages, 15 exact-version exceptions. |
| `corepack pnpm run quality:secret-scan` | Pass; tracked repository text, including hidden files. |
| `corepack pnpm run quality:bundle-secrets` | Pass; emitted web assets contain no server credential markers. The build emitted no `.map` files; the checker includes `.map` when future builds emit source maps. |
| `corepack pnpm run quality:negative` | Pass. Temporary canaries proved ESLint rejects a parse error; Vue typecheck rejects TS2322; Secretlint rejects a synthetic GitHub token; license policy rejects an `UNLICENSED` package; Node/pnpm mismatch policy rejects incompatible versions; PR workflow rejects secret references and non-allowlisted environment variables. Canary files are removed in `finally`. |
| `corepack pnpm run quality:check` | **Blocked / exit 1 at dependency audit after all preceding aggregate gates passed.** |

Dependency audit was run against the official registry because the configured `npmmirror.com` registry returned `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`:

```text
corepack pnpm --registry=https://registry.npmjs.org audit --audit-level high --json
```

Result: 2,173 dependencies; 111 advisories total: 9 low, 44 moderate, 57 high, 1 critical. Findings include paths through the absent `apps/backend-mock` importer as well as active frontend/build paths such as `packages__effects__request>axios`, `.>vite`, and `internal__vite-config>...`. Therefore the complete lockfile quality gate correctly exits non-zero. The result cannot be represented as a green Task 2 gate, and no advisories were ignored or auto-fixed.

## Remaining gaps and next step

- Task 2 remains **incomplete** until high/critical advisories are addressed through reviewed lockfile changes and the aggregate gate is rerun green.
- This local checkout has no Git remote, so GitHub Actions has not produced a hosted PR run and branch protection is not enabled/verified here. Do not treat the workflow file as hosted CI evidence.
- Business-flow Playwright, Auth/API, Postgres/RLS and staging checks remain in later tasks; no Task 3 work was started.
- Preserve the current lockfile audit failure as the blocking evidence. Do not start Task 3 from this state.

## 2026-10-05 Task 2 resumption

- Starting state: branch `feat/ops-console-task-1-vben-foundation`, HEAD `0769b572fd55986a7292d782ddbbff1a1b1e45e4`, clean worktree. Scope remained `~admin`; no changes were made in `udone`. No Git remote is configured.
- Reproduced the full official-registry audit: 2,173 dependencies, 111 advisories (9 low, 44 moderate, 57 high, 1 critical). The actual pnpm workspace has 39 projects and does not include `apps/backend-mock`; that importer existed only in the stale lockfile. `pnpm install --lockfile-only --ignore-scripts` regenerated the full lockfile against all 39 actual workspaces and removed that importer. The complete lockfile audit was kept enabled.
- Applied `pnpm audit --fix` once to obtain the registry's suggested patched ranges, then reviewed and reduced its broad generated constraints. Kept only the project catalog upgrades for Axios `^1.20.0`, Vite `^8.0.16`, PostCSS `^8.5.23`, and the Tiptap family `^3.31.4`; retained targeted lock resolutions for glob `10.5.0` and brace-expansion `5.0.12`. No vulnerability was ignored and no audit threshold/scope was changed.
- Updated the exact-version license exceptions after checking license scan output: caniuse-lite `1.0.30001814` (CC-BY-4.0) and lightningcss `1.33.0` (MPL-2.0). Retained the still-installed Windows lightningcss `1.32.0` exception. License gate passed for 1,533 installed packages and 16 exact-version exceptions.
- Frozen filtered install passed with Node `24.20.0` / pnpm `10.33.4`. The install reported peer warnings: `vite-plugin-inspect`/`vite-dev-rpc` declare Vite 6/7 peer ranges while the resolved Vite is 8.3.2; build/typecheck/lint still passed. This compatibility warning remains for review.
- Negative gate: `corepack pnpm run quality:negative` passed. It rejected intentional ESLint, typecheck, Secretlint, UNLICENSED, toolchain mismatch, and PR workflow secret/environment canaries as expected.
- Aggregate gate: `corepack pnpm run quality:check` passed toolchain, format (974 files), lint, typecheck, Vitest (35 files / 309 tests), `web-antd` production build, licenses, repository secret scan, bundle secret scan, and negative gates. The final full-lockfile official registry audit failed with 6 advisories: 4 moderate and 2 high, 0 critical. The remaining high findings are `node-forge@1.4.0` through `internal__vite-config > nitropack > listhen` and `braces@3.0.3` through `@changesets/cli > @changesets/config > micromatch`; for both, npm reports patched versions `<0.0.0` (no fix available). Aggregate exit code: 1 at dependency audit.
- Hosted PR CI and branch protection remain unverified because there is no Git remote. No PR or remote resource was created. Task 2 remains unchecked/incomplete; Task 3 was not started. Next: resolve/remove the two affected dependency paths through upstream fixes or a reviewed dependency change, then rerun full quality gates; separately validate the required check on the hosting platform when a remote is available.

## 2026-10-05 official advisory refresh

- Reconfirmed the exact lockfile packages and dependency paths: `node-forge@1.4.0` at `internal__vite-config > nitropack > listhen > node-forge`, and `braces@3.0.3` at `. > @changesets/cli > @changesets/config > micromatch > braces`.
- Current npm audit entry for node-forge is [GHSA-86w9-cpqp-85rv / CVE-2026-85393](https://github.com/advisories/GHSA-86w9-cpqp-85rv), published 2026-09-03. It describes a signature-forgery issue through 1.4.0; GitHub lists affected/patched versions as unknown and has no package mapping. npm's package page still lists `1.4.0` as latest, so no compatible fixed npm release is available to resolve to. This is later than the older node-forge advisories fixed in 1.4.0.
- Current braces entry is [GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), published 2026-09-18 and reviewed/updated 2026-10-02. GitHub lists `<=3.0.3` affected and `None` for patched versions; locked 3.0.3 remains the latest affected release with no compatible patched version.
- Fresh full official-registry lockfile audit: 4 moderate, 2 high, 0 critical; exit 1. The two high findings map to the advisories above; no threshold, ignore list, or scan scope changed.
- Fresh `corepack pnpm run quality:check`: toolchain, format (974 files), lint, typecheck, 35 Vitest files / 309 tests, web build, license policy (1,533 installed packages / 16 exact exceptions), repository and bundle secret checks, and all negative canaries passed. The final dependency audit failed with the two high findings above. Existing Vitest hoisted-mock warning remains non-fatal.
- No compatible release exists to upgrade to at this recheck. Task 2 remains incomplete and unchecked; Task 3 remains unstarted. Hosted PR checks remain unverified because this checkout has no Git remote.

## 2026-10-05 Task 2 dependency-path assessment and gate rerun

- Starting state: `D:/Coding/ERP/~admin`, branch `feat/ops-console-task-1-vben-foundation`, HEAD `e65a6b5fc4719e062be2bcae8ee0a539953fad22`, clean worktree, no Git remote. No files in `udone` were read or changed for implementation.
- `corepack pnpm --registry=https://registry.npmjs.org audit --audit-level high` reproduced 6 full-lockfile findings: 4 moderate, 2 high, 0 critical. The high paths are `internal__vite-config > nitropack > listhen > node-forge` and `. > @changesets/cli > @changesets/config > micromatch > braces`; npm reports no patched version (`<0.0.0`). `corepack pnpm why -r node-forge` and `corepack pnpm why -r braces` confirmed these paths; braces is also reachable through shared `micromatch` consumers used by other lint/build tools.
- Refreshed the official [node-forge GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). GitHub lists both as high with no patched version; npm registry dist-tags still report `node-forge@1.4.0` and `braces@3.0.3` as latest. The audited node-forge issue concerns RSA PKCS#1 v1.5 signature verification; the braces issue is stack exhaustion on deeply nested patterns.
- Reachability assessment: node-forge is in the local Vite/Nitro mock development toolchain, not the generated browser bundle. The `web-antd` development config enables Nitro mock, while the imported workspace lacks the default `@vben/backend-mock` package; the plugin skips startup when it cannot resolve the configured package. This narrows likely invocation to development tooling but does not make the lockfile advisory disappear. Changesets is connected to the repository's release/version scripts and workflow. `braces` is shared below micromatch in additional tooling paths, so removing only the displayed Changesets importer would not establish absence of the vulnerable package.
- Ruling: no safe minimal dependency-path removal or published fixed release is available while preserving the imported Vben mock configuration and Changesets/release tooling. Removing those capabilities, rewriting several tool dependency trees, or applying an unpublished fork would expand/alter the requested toolchain without a verified upstream fix. No dependency, audit policy, or scanner scope was changed; Task 2's advisory item remains unchecked.
- `corepack pnpm install --filter '@vben/web-antd...' --filter '@vben/vsh...' --filter '@vben/vite-config...' --filter '@vben/eslint-config...' --filter '@vben/oxfmt-config...' --filter '@vben/oxlint-config...' --filter '@vben/stylelint-config...' --filter . --frozen-lockfile` → exit 0; lockfile current, 35/39 workspace projects selected. Upstream `internal/node-utils` emitted the previously observed non-fatal Node `[DEP0190]` warning.
- `corepack pnpm run quality:check` → exit 1 at the final full-lockfile dependency audit. Toolchain, format, lint, typecheck, Vitest (35 files / 309 tests), `web-antd` build, license check (1,533 packages / 16 exact-version exceptions), repository/bundle secret checks, and negative canaries passed. The audit reported 4 moderate and 2 high, 0 critical. Full output was retained in ignored `.superpowers/sdd/2026-10-05-ops-console-implementation/task-2-quality-check.log` for this run.
- Hosted PR CI and `Frontend Quality / frontend-quality` branch protection remain unverified because there is no Git remote. Task 2 remains incomplete; Task 3 was not started.
