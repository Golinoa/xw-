# Code writing standards

> 状态：项目规范基线　|　适用范围：TypeScript、Vue、Hono 与 SQL 代码

## 1. Language and architecture

- TypeScript uses the workspace `strict` compiler setting. Public boundaries receive explicit input/output types; untrusted JSON, query, path, environment and provider values start as `unknown` and are validated before use.
- Avoid `any`. If an external library forces it, isolate the cast at the adapter edge and state why the type cannot be represented safely.
- Keep UI rendering, HTTP translation, application/domain rules and persistence in their assigned layers. Follow [ARCHITECTURE.md](../ARCHITECTURE.md) and [ENGINEERING_DESIGN.md](ENGINEERING_DESIGN.md); do not introduce cross-layer imports to bypass a boundary.
- Pages coordinate workflows; reusable UI belongs in components only when reuse or a shared behavior is real. Domain rules do not depend on Vue, Hono, Supabase SDK, or provider-specific UI.
- Prefer direct code over speculative abstractions. Extract a helper when it names a meaningful rule or removes repeated behavior, not merely to shorten a file.

## 2. Naming and file organization

- Follow the language convention already used by the package: `camelCase` for values/functions, `PascalCase` for types/classes/Vue components, and descriptive `kebab-case` or existing package file naming for files.
- Use domain names consistently across UI, API contracts, services, and SQL. Do not abbreviate business concepts differently in adjacent layers.
- Keep tests next to the unit as `*.test.ts`; SQL policy/transaction tests live under `supabase/tests/`; browser workflows live in `tests/e2e/` or `tests/smoke/` according to their execution target.
- Keep package imports inside the workspace contract. Do not reach into another package's private file path when a public export exists; if it does not, expose the smallest stable public entry.

## 3. Error handling and comments

- Convert expected validation, authorization, conflict and dependency failures into stable user-safe errors at the boundary. Preserve unexpected failures for internal diagnosis with a request ID; do not return stack traces, SQL text, tokens, or provider secrets.
- Catch an error only when the caller can recover, add useful context, translate it to the shared API contract, or deliberately roll back. Do not swallow errors or return success-shaped defaults after failure.
- Comments explain a non-obvious invariant, security boundary, compatibility constraint, or deliberate exception. They must not repeat what the code already says.
- Use TODO only with an ownerable outcome or linked issue/plan; do not use TODO to hide an unresolved behavior decision.

## 4. Prohibited shortcuts and safer alternatives

- Do not scatter magic values that encode business meaning, policy, units, limits, timeouts, retry counts, or status codes. Give them a domain-named constant, enum, shared contract, or validated configuration. Plain arithmetic (`0`, `1`), obvious local indexes, and one-off layout values may remain inline; do not create meaningless constants just to remove every literal.
- Do not use `any`, non-null assertions (`value!`), or double casts (`as unknown as T`) to silence type errors in production paths. Narrow with validation, guards, typed adapters, or explicit fallible results. Tests may use a narrow assertion only when setup proves the invariant and the reason is clear.
- Do not use `@ts-ignore` or disable a lint/type rule without a narrow scope, explanation, and follow-up condition. Prefer `@ts-expect-error` for a deliberate test of an invalid type contract.
- Do not swallow rejected promises, use empty `catch` blocks, or launch untracked fire-and-forget work. Await it, return/propagate the failure, or route it through a documented background-job boundary with failure reporting.
- Do not rely on truthiness to distinguish valid values when `0`, `false`, `''`, `null`, or `undefined` have different meanings. Use explicit checks and documented defaults; do not silently coerce identifiers, money, dates, or enum/status inputs.
- Do not hardcode secrets or log credentials, full request bodies, or unnecessary personal/financial data. Read secrets from runtime configuration and log safe identifiers plus the request ID; follow [SECURITY.md](SECURITY.md).
- Do not render untrusted HTML with Vue `v-html` or concatenate untrusted values into SQL. Keep normal Vue interpolation escaping; use parameterized SQL/data APIs, and strictly allowlist identifiers when dynamic SQL structure is unavoidable. See [database standards](DATABASE_STANDARDS.md).
- Do not duplicate API field names, permission strings, status sets, or error codes across layers when a shared contract is appropriate. Import the public contract; keep UI labels separate from stable machine values.
- Do not handle money with binary floating-point arithmetic or compare timestamps without an explicit timezone/domain rule. Use integer minor units or a documented decimal representation, and keep date-only values distinct from instants.

## 5. Formatting and static checks

- Prettier config is `.prettierrc.json`; run `pnpm format:check`. PostgreSQL SQL uses the dedicated `sql-formatter` configuration through `pnpm format:sql:check`. Build output, dependency trees, coverage and temporary directories are excluded.
- Run `pnpm lint` for ESLint flat config with TypeScript and Vue rules. `pnpm typecheck` remains a separate compiler gate.
- Do not reformat generated research captures or ignored build/test artifacts. When applying the formatter to source, preserve behavior and review the formatted diff.
- CSS color token usage follows root `DESIGN.md` and approved `.harness/Design-system/` guidance; `pnpm css:tokens:check` rejects new raw hex/RGB/HSL colors in Vue/CSS. Only the exact existing color counts in `AppLayout.vue`, `HomeView.vue`, and `LoginView.vue` are grandfathered; do not add colors to those exceptions, and remove them when the screens next change. Spacing/typography token use is a source/design review item.

## 6. Change review

- Review for architecture boundary changes, input validation, authorization and tenant scope, data loss, async failure behavior, accessibility and user-visible empty/error states.
- Keep a change limited to the requested behavior. Preserve unrelated working-tree edits and generated files.
- For component appearance, follow root [DESIGN.md](../DESIGN.md); for new behavior, follow [TESTING_STANDARDS.md](TESTING_STANDARDS.md).

## Related standards

- [API and permission conventions](API_STANDARDS.md)
- [Database standards](DATABASE_STANDARDS.md)
- [Testing standards](TESTING_STANDARDS.md)
- [Engineering workflow](ENGINEERING_STANDARDS.md)
