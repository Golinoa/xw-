# API and permission standards

> 状态：项目规范基线　|　适用范围：Hono API、共享契约和调用 API 的客户端

## 1. Contract ownership

- Stable request, response, permission and error types belong in `packages/contracts`; API route and frontend code consume that public contract.
- JSON uses the existing lower-camel-case field convention. Do not invent target-site fields, routes, status values or permissions without a confirmed product requirement.
- Keep current route paths compatible unless a feature explicitly approves a versioned migration. There is no global `/api/v1` prefix today; do not imply that it exists.
- The shared `ApiResponse<T>` envelope has been **removed**. Success responses return the resource body directly; failures return the flat `{ code, message, requestId, details? }` body from `apiErrorBodySchema`. Do not reintroduce an envelope without an explicit coordinated migration (it would require changing every existing endpoint, its tests and the browser client in one batch).
- Every endpoint must be registered in the shared `ROUTES` registry with request/response zod schemas, and the route handler must use `respond()`. Full rules and rationale: [contract standards](CONTRACTS.md).

## 2. Input and response behavior

- Parse and validate path parameters, query values, headers and JSON bodies at the HTTP boundary. TypeScript annotations alone do not validate runtime input.
- Use `parseJson`, `parseParams` and `parseQuery` from `apps/api/src/lib/contract.ts`. Direct `context.req.json()` calls bypass the shared validation error shape and are not allowed in route handlers.
- Return responses through `respond(context, routeKey, data, status?)` so the outbound payload is checked against the same schema the browser client uses. A mismatch fails closed with `500 INTERNAL_ERROR` and a `response_contract_violation` log entry instead of silently shipping a drifted shape.
- Define reusable runtime schemas with the workspace-pinned Zod dependency in `packages/contracts` when the request/response contract is shared; route handlers parse untrusted input before use. Cover valid and rejected inputs with `pnpm test`, then run `pnpm lint` and `pnpm typecheck`.
- Reject malformed or out-of-range input with a stable validation error. Normalize only documented values; do not silently coerce identifiers, money, dates or status values.
- Use HTTP methods and status codes according to operation semantics. Create operations return a creation status where appropriate; authorization, validation and conflict cases use their corresponding stable contract errors.
- List endpoints define bounded pagination, deterministic ordering, filters and empty-result behavior before implementation. Pagination format is feature-specific until a shared contract is approved.
- Return only fields the caller may read. Avoid leaking database/provider errors or returning privileged/internal fields.

## 3. Authentication, authorization and tenancy

- Protected operations authenticate through server middleware. Derive `userId`, `organizationId`, role and session from verified context, never from a client-supplied ownership field.
- Check permission at the operation boundary for every read/write/export/download. A hidden or disabled frontend control is not authorization.
- Validate resource ownership against the trusted organization context before access. Database RLS remains the second enforcement layer; API authorization does not replace RLS.
- Permission names and role mappings come from shared contracts/product requirements. Do not infer a broad permission from a role name or grant implicit access.
- Cross-organization switching verifies current membership, then establishes the selected context through the approved session flow.

## 4. Errors and request tracing

- Use the shared error body `{ code, message, requestId, details? }` and the established error-code set in `packages/contracts`.
- Keep `message` safe and actionable. Put only validated, non-sensitive field detail in `details`; never include credentials, SQL, stack traces or raw provider responses.
- Return the request ID in the response header/body and include it in server diagnostics. Logs must not contain bearer tokens, cookies or unnecessary personal/financial information.
- Map expected failures consistently: authentication required, forbidden, organization context required, validation, conflict, and internal error. Do not expose internal failure distinctions that create an information leak.

## 5. Idempotency, transactions and compatibility

- Financial, approval and other non-repeatable writes need an explicit duplicate-submission strategy before implementation. Add idempotency only when its request key, persistence and replay behavior are specified.
- Multi-record state changes use a database transaction/RPC or an equivalent atomic service boundary. Do not split an invariant across independent HTTP calls.
- API changes review existing clients, permission checks, tenant behavior, error contract and migration compatibility. Breaking changes require an explicit transition plan.

## Related standards

- [Contract and type consistency](CONTRACTS.md)
- [Code writing standards](CODE_STANDARDS.md)
- [Database standards](DATABASE_STANDARDS.md)
- [Security rules](SECURITY.md)
- [Testing standards](TESTING_STANDARDS.md)
