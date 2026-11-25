import type { Page, Route } from '@playwright/test';

import { authContextSchema, meResponseSchema } from '@erp/contracts';

/**
 * 认证相关的最小夹具。
 *
 * 所有响应体一律**先过契约**再交给页面：`contracts` 改了字段而夹具没跟上时，
 * 这里会直接抛 schema 错误，用例当场红——比「页面看似正常、其实字段已经喂错」
 * 便宜得多。踩过一次：切换公司的响应漏了 `permissions`，表现却是「点了没反应」。
 */

/** Supabase `signInWithPassword` 的令牌响应（该端点不属于业务契约，手写形状即可）。 */
export const fixtureSession = {
  access_token: 'fixture-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'fixture-refresh-token',
  user: {
    id: 'user-fixture',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'staff@example.test',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: '2026-10-03T00:00:00.000Z',
  },
};

/** `/api/me`：两个组织，首个是默认（登录后自动选中）。 */
export const fixtureMemberships = meResponseSchema.parse({
  userId: 'user-fixture',
  memberships: [
    { organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'admin' },
    { organizationId: 'org-beta', organizationName: 'Beta Travel', role: 'operator' },
  ],
});

/** 组织上下文必须是契约里定义的形态，前端会拿它渲染角色与数据范围。 */
export const fixtureAuthContext = authContextSchema.parse({
  userId: 'user-fixture',
  organizationId: 'org-alpha',
  role: 'admin',
  sessionId: 'session-fixture',
  permissions: ['customer.read', 'customer.write', 'order.read', 'order.write'],
  dataScope: 'all',
});

/**
 * 装一套认证桩：登录、登出、成员信息、未读通知数。
 *
 * 不覆盖 `/api/*` 的业务端点——那些由各用例自己按需回放，
 * 免得不相关的用例被一张「万能桩」养出假绿。唯一的例外是未读数：它由顶栏
 * 常驻组件在每次进页面时发出，不放桩会让每条用例都带一次失败请求，
 * 看起来像页面出错。
 */
export async function installAuthStub(
  page: Page,
  options: { memberships?: typeof fixtureMemberships.memberships } = {},
) {
  const memberships = options.memberships ?? fixtureMemberships.memberships;

  await page.route('**/auth/v1/token*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fixtureSession),
    }),
  );

  await page.route('**/auth/v1/logout*', (route) => route.fulfill({ status: 204 }));

  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...fixtureMemberships, memberships }),
    }),
  );

  await page.route('**/api/notifications/unread-count', (route) =>
    fulfillJson(route, { count: 0 }),
  );
}

/** 统一的 JSON 回放。响应体建议先过契约再传进来（见文件头说明）。 */
export async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * 走完一次登录：填邮箱密码 → 提交。返回时页面已跳走。
 *
 * 两个选择器都不是随手写的：
 * - 输入框用 placeholder：Vben 的输入组件会附带「显示密码」之类的图标按钮，
 *   按可访问名匹配容易同时命中多个元素；placeholder 来自文案表，唯一且稳定。
 * - 提交按钮的可访问名是 `login` 而不是文案「登录」：上游 `AuthenticationLogin`
 *   给它写死了 `aria-label="login"`（packages/effects/common-ui/src/ui/authentication/login.vue）。
 *   按文案找会一直等到超时，页面看起来却完全正常。
 */
export async function signIn(page: Page) {
  await page.getByPlaceholder('请输入登录邮箱').fill('staff@example.test');
  await page.getByPlaceholder('请输入密码').fill('fixture-password');
  await page.getByRole('button', { name: 'login' }).click();
}
