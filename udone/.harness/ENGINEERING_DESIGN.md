# Design rules

- Keep business rules in the backend service/domain path and enforce them server-side.
- Keep HTTP translation in controllers and persistence access in repositories.
- Use explicit request/response types at API boundaries; validate untrusted input.
- Keep audit-sensitive actions attributable and transactionally coherent.
- Document meaningful architectural decisions in `docs/design-docs/`; separate target-site evidence from replication recommendations.
- Avoid speculative abstractions. Add an abstraction when it clarifies an existing repeated rule or boundary.
- Generated schema output is derived from migrations and must not be manually edited.

Implementation conventions are detailed in [code writing standards](CODE_STANDARDS.md), [API standards](API_STANDARDS.md), [database standards](DATABASE_STANDARDS.md), and [testing standards](TESTING_STANDARDS.md). Workspace and release checks are in [engineering standards](ENGINEERING_STANDARDS.md).

## Local engineering gates

Run `pnpm format:check`, `pnpm format:sql:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check:deploy` before proposing a code change. Dependency, secret, and generated schema checks are `pnpm deps:audit`, `pnpm licenses:check`, `pnpm secrets:check`, and `pnpm schema:check`. SQL formatting is intentionally a separate PostgreSQL-aware command. Their CI counterparts run on pull requests; pgTAP runs in an isolated local Supabase stack through `pnpm db:test`.
