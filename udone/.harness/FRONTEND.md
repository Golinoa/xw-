# Frontend conventions

## Confirmed stack

Vue 3, TypeScript, Vite, and Ant Design Vue. The frontend is deployed with the Hono API on Cloudflare Workers. Confirm implementation details against `Docs/TECH_SELECTION.md` and the active plan. AI chat components are out of scope until the agent feature is approved; evaluate the community Vue implementation `ant-design-x-vue` at that time rather than adding it as a current dependency.

## Components and state

- Keep pages focused on workflows and compose reusable components where this reduces duplication.
- Use shared request/response/error/permission types from the contracts package.
- Route API calls through the typed client; do not call Supabase with privileged credentials from the browser.
- Keep authorization on the API and database RLS layers. Hiding a control in Vue is not authorization.
- Represent loading, empty, validation, and failure states explicitly. Confirm destructive business actions.
- Keep presentation concerns out of domain rules.
- Test component behavior and critical workflows according to [testing standards](TESTING_STANDARDS.md); keep API payloads and errors aligned with [API standards](API_STANDARDS.md).

## Static checks and component test status

Format Vue/TypeScript sources with `pnpm format:check` and lint them with `pnpm lint`; do not bypass the shared contracts or server authorization rules to satisfy a lint rule. The current test environment is Vitest (`pnpm test`); component-test utilities are not installed yet, so Vue component behavior tests remain a documented gap until a component behavior change justifies adding that adapter. Critical user flows continue to use Playwright where they can run without staging credentials.

Use CSS custom properties from root [DESIGN.md](../DESIGN.md) and approved `.harness/Design-system/` guidance for colors. `pnpm css:tokens:check` rejects new hard-coded hex/RGB/HSL color values in Vue/CSS sources and runs as part of `pnpm lint`. It permits only the exact existing color counts in `AppLayout.vue`, `HomeView.vue`, and `LoginView.vue` as legacy exceptions; do not add values to these exceptions, and remove them when those screens next change. Spacing and typography token use remain a design review item.

## Current test coverage boundary

Vitest discovery is limited to `apps/`, `packages/`, and `tests/`; managed worktrees are excluded. No Vue component-test setup or coverage threshold is configured. Introduce component behavior tests when a component behavior change needs them, and add any new test tooling through the engineering dependency review.
