# Database standards

> 状态：项目规范基线　|　适用范围：Supabase PostgreSQL、SQL migrations、RLS、RPC/事务函数和数据库测试

## 1. Source of truth and migrations

- Physical schema is defined only by versioned SQL under `supabase/migrations/`. Product mockups, target-site screens and API payloads are not schema evidence.
- Add an ordered timestamp migration named `YYYYMMDDHHMMSS_short_description.sql`; do not rewrite an already-applied migration to change behavior.
- Migrations must be repeatable from an empty local database and compatible with the supported PostgreSQL/Supabase version. Keep schema changes, RLS/grants and required database functions reviewable together.
- Prefer additive migrations. For risky changes, add the new representation, backfill, switch readers/writers, then remove the old representation in a later approved migration.
- Review locks, table size, defaults, nullability, foreign-key validation and backfill duration before production rollout. Destructive changes need an explicit data-retention and recovery decision.

## 2. Data integrity and query design

- Enforce important invariants in the database using `NOT NULL`, `CHECK`, `UNIQUE`, foreign keys and transactions, not only in form validation.
- Define `ON DELETE` behavior deliberately. Prefer restrictive behavior for audit/financial history; cascade only when child data is truly owned and safe to remove with its parent.
- Add indexes for measured or required filter/join/order paths. Avoid speculative indexes and redundant indexes that duplicate a unique constraint.
- Store instants in `timestamptz`; use explicit domain rules for local dates, currency precision, rounding, and status transitions. Do not guess money scale or timezone semantics when a product contract is missing.
- Use stable IDs and consistent domain names. Do not add denormalized or duplicated state without a reconciliation/update rule.
- Do not build SQL by concatenating request or provider values. Use parameterized queries/RPC arguments; if identifiers or sort directions must be dynamic, select them from a fixed allowlist because SQL parameters cannot bind identifiers.

## 3. Tenant isolation and grants

- Every organization-owned row carries a foreign key to its owning organization and has RLS enabled. Policies must cover each required operation and use trusted `auth.uid()`/verified organization context.
- Test both allowed and denied paths: member vs non-member, correct vs incorrect organization, permitted vs denied role, and attempted cross-tenant insert/update/delete.
- Grants and RLS are separate controls. Revoke default broad privileges where needed and grant only required table/column/function operations to the intended roles.
- `SECURITY DEFINER` functions require a fixed safe `search_path`, explicit execute grants, input validation, and tests for unauthenticated, unauthorized and cross-tenant callers.
- Keep role and permission policy aligned with API shared contracts; database policies remain authoritative for row isolation.

## 4. Transactions and audit history

- Keep multi-table business invariants in one transaction/RPC. A failed step must roll back the entire operation.
- Use constraints to prevent duplicate business relationships and race-prone conflicts; handle expected uniqueness conflicts with a stable API error.
- Sensitive state changes record attributable audit information within the same transaction where the verified workflow requires it. Do not log credentials or unnecessary personal data in audit metadata.
- Do not implement an irreversible financial or approval transition until its authorization, self-approval rule, idempotency and recovery behavior are specified.

## 5. Database testing and deployment

- Test schema constraints, grants, RLS policies and transaction behavior with database tests (currently pgTAP files under `supabase/tests/`). Include positive and negative access cases.
- Run `pnpm format:sql:check` for SQL layout and `pnpm db:test` (`supabase test db --local`) against an isolated local PostgreSQL/Supabase database. CI starts a disposable local stack; a TypeScript test that mocks Supabase does not prove PostgreSQL RLS behavior.
- For remote rollout, inspect linked migration state, run a dry run, review the exact pending migration files, then apply only the explicitly authorized target. Do not use reset/seed against shared or production databases.
- Record whether a migration is forward-fix-only or has a tested recovery path. A reverse SQL file is not automatically safe rollback when data has changed.

## 6. Generated schema inventory

- `.harness/docs/generated/db-schema.md` is generated output and must not be hand-edited. SQL migration files remain authoritative.
- Regenerate `.harness/docs/generated/db-schema.md` only with `pnpm schema:generate`; `pnpm schema:check` verifies that the checked-in report matches all migrations. The current repository has four migration sources. Never update the report by hand.

## Related standards

- [API and permission standards](API_STANDARDS.md)
- [Testing standards](TESTING_STANDARDS.md)
- [Security rules](SECURITY.md)
