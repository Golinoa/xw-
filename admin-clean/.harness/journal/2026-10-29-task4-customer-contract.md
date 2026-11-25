# 2026-10-29-task4-customer-contract-frontend

## Task

Task 4 (frontend portion) of `.harness/docs/exec-plans/active/2026-10-05-ops-console-implementation.md` in `admin`: turn the customer, catalog and contract placeholder pages into working business pages, with the domain API clients, honest dev-data isolation, and unit tests.

Scope boundary honoured: only `apps/web-antd/src/views/ops/{customer,catalog,contract}/**`, `apps/web-antd/src/api/ops/{customer,catalog,contract}/**`, the three route modules, and this journal. No changes to adapter/request/core/store/guard/access/constants/permissions, `__stub__/`, the billing domain or any `package.json`; no `pnpm install`.

## What was built

### API clients (contract §5.2–§5.4, §2.2, §2.4, §2.5, §3.0)

- `api/ops/customer/index.ts`: 8 endpoints (list, create, duplicate-check, detail, patch, transition, overview, contacts CRUD), `CustomerStatus`/`CustomerTransitionAction`, server-side paging/sorting enums, `OPS_PAGE_SIZE_OPTIONS`/`OPS_DEFAULT_PAGE_SIZE`.
- `api/ops/catalog/index.ts`: products, packages, price versions, package transitions, feature definitions; `formatMoney`-friendly `numeric(14,2)` number types.
- `api/ops/contract/index.ts`: contracts, items, detail, versions, entitlement preview, renewals, attachments; every write carries `Idempotency-Key` (`createIdempotencyKey()` falls back when `crypto.randomUUID` is unavailable).
- `PATCH` goes through `requestClient.request(url, { method: 'PATCH', data })` because the shared client exposes no `patch` helper.
- Fields are copied verbatim from the contract; nothing is invented. Derived items are marked `[推导]` in code and listed per domain README.

### Pages

- customer: `list.vue` (server paging/filter/sort, create drawer, suspend confirm that pre-fetches `overview` + detail for impact and `version`), `detail.vue` (profile, transitions incl. terminate acknowledgement, contacts, relation counts).
- catalog: `products.vue`, `plans.vue`, `plan-detail.vue` (current price version vs read-only history), `features.vue`.
- contract: `list.vue`, `create.vue` (per-line product/package/price-version selection, read-only total), `detail.vue` (items, versions, attachments, receivables, entitlement preview, transitions, renewal).
- Shared state components: `ops-dev-data-notice`, `ops-permission-denied` (403 + required action code, never reveals whether data exists), `ops-error-alert` (message + `requestId` + retry).
- Routes: detail/create sub-routes added with `hideInMenu` + `activePath`; `meta.authority` carries action codes only.

### High-risk action (`contract.approve`)

`high-risk-confirm.vue` renders the impact summary, requires a reason and an explicit acknowledgement checkbox, and only then emits `confirm`. Validation lives inside the component, so an unconfirmed click cannot reach `transitionContract` (covered by `high-risk-flow.test.ts`). Medium-risk actions (submit/withdraw) keep the confirmation but make the reason optional.

### Dev-data isolation

`VITE_OPS_MOCK === 'true'` is compared as a literal and the mock module is dynamically imported, so production builds tree-shake it. Fixtures are clearly fictional (`示例旅行社甲`, `138****1234`, `c***@example.invalid`); every page shows a "开发态数据" banner.

### Tests

`views/ops/{customer,catalog,contract}/__tests__/`: form validation (required/pattern/region code, 409 keeps input), contact masking branch without `customer.sensitive.read`, money formatting + price-version snapshot display, product/package validation, high-risk confirmation gating, and a detail-page flow asserting `transitionContract` is not called before reason + acknowledgement.

## Validation (run with Node 24.20.0 from `D:/MYC/A.soft/nodejs-24.20.0`)

- `corepack pnpm --filter @vben/web-antd typecheck` → pass, no diagnostics.
- `corepack pnpm --filter @vben/web-antd test:unit` → `Test Files 23 passed (23)`, `Tests 171 passed (171)`.
- `corepack pnpm run lint:check` → `Found 0 warnings and 0 errors` (oxlint 160 files), eslint and stylelint clean.

Two flaky 5 s timeouts were observed in pre-existing tests outside this task's boundary (`views/ops/billing/__tests__/receipt-approve-button.test.ts`, `api/__tests__/stub-contract.test.ts`) when the whole suite runs in parallel; both pass in isolation and on a re-run, and were left untouched.

## Bugs found and fixed in-scope

- `product-form.vue` had `watch(() => props.initial, …, { immediate: true })` which overwrote the default `saasEnabled: true` with `false` in create mode, silently blocking creation. Now returns early when `initial` is null.
- Mock deep-clone helpers used `JSON.parse(JSON.stringify(…))`; replaced with `structuredClone`.

## Files changed

- Added: `api/ops/{customer,catalog,contract}/{index.ts,fixtures.ts,mock.ts}` (mock/fixtures new), `views/ops/customer/{list.vue,detail.vue,format.ts,components/*}`, `views/ops/catalog/{products.vue,plans.vue,plan-detail.vue,features.vue,format.ts,components/*}`, `views/ops/contract/{list.vue,create.vue,detail.vue,format.ts,components/*}`, seven `__tests__` files, three domain READMEs (rewritten from "未实现" to implemented + open questions).
- Modified: `router/routes/modules/{customer,catalog,contract}.ts` (added detail/create routes only).

## Open questions for backend (also in each domain README)

1. `packages.status` enum is not defined in the contract; inferred as `draft`/`active`/`retired`.
2. `PackagePriceVersion.id` is missing from the documented response but required by contract items; optional in types, `versionNo` fallback.
3. `ProductListItem.version`/`description` must be returned by the list because there is no product-detail endpoint.
4. `ContractVersionEntry.snapshotSummary` internal shape is undefined; optional fields assumed.
5. Renewal lead window (90 days in the stub) and `RENEWAL_NOT_DUE` semantics.
6. `CustomerOverview` item shapes and `CustomerDetail.counts` delivery.
7. `Idempotency-Key` reuse window on retry.
8. Attachment `complete` step not implemented (no UI entry needed yet).

## Risks

1. Mock-only verification: state machines, `OBJECT_REFERENCED` and `CONTRACT_IMMUTABLE` are exercised against the local stub, not a real backend.
2. The `version` optimistic-lock fields are only as good as the contract; if a read endpoint omits them, edit flows will 409 until the backend supplies them.
3. Dev-data banner and tree-shaking rely on `VITE_OPS_MOCK` being a build-time literal; changing it to a runtime value would leak fixtures into production.
