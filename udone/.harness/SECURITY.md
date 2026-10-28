# Security rules

- Enforce authentication, permission checks, and tenant scoping on the server for every protected operation. Derive tenant identity from trusted session/context, not client-supplied ownership fields.
- Validate and authorize object IDs on reads, writes, exports, and attachment downloads to prevent IDOR and cross-tenant access.
- Never commit `.env`, credentials, signing keys, tokens, cookies, or unredacted production evidence. Keep secrets in environment/secret-manager configuration.
- Use HTTPS in production; do not expose PostgreSQL, MinIO, or RabbitMQ management ports publicly. Use least-privilege database credentials and strong random JWT secrets as described in deployment guidance.
- Treat uploads, CSV imports/exports, AI input, and logs as untrusted or sensitive data paths. Apply size/type validation, authorization, and redaction.
- Financial approval must prevent self-approval where required by the verified workflow; frontend controls alone are insufficient.
- Avoid adding dependencies with known security issues. Review package maintenance, license and security advisories before adding one; every lockfile advisory is blocked in CI and license expressions require explicit policy approval.
- Every lockfile advisory blocks `pnpm deps:audit` regardless of severity; run it against the npm registry. License expressions must be listed in `scripts/license-policy.json`; exceptions need a package/version scope, reason, owner approval and review date. `pnpm licenses:check` fails on unknown or pending expressions.
- Run `pnpm secrets:check` before review. Its synthetic blocking/redaction check is `pnpm secrets:canary:check`; secrets are masked in scanner output. Local-only generated evidence and binary research captures are excluded by `.secretlintignore` and are not CI source inputs.
- Cross-tenant isolation and several attachment/export controls remain research gaps; track them rather than claiming they are verified.
- Before introducing a new personal or financial data flow, specify its purpose, authorized roles, export/audit behavior, retention and deletion path. Do not place real data in fixtures, logs or journals.

Dependency and license review follows [engineering standards](ENGINEERING_STANDARDS.md); API and row-level authorization follows [API standards](API_STANDARDS.md) and [database standards](DATABASE_STANDARDS.md).

## Organization request context

- `X-Organization-ID` is a selection request, not authority: the Worker must validate the bearer session and membership before using it, and PostgREST/RLS must independently match it to `auth.uid()`. Missing selection is reserved for own-membership discovery and organization creation; malformed or nonmember selections fail closed. Recheck membership on each request so removal takes effect on subsequent requests.
