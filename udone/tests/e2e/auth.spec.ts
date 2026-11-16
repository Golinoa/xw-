import { expect, test } from '@playwright/test';
import { authContextSchema, meResponseSchema } from '@erp/contracts';

const fixtureSession = {
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

/**
 * 桩体一律过契约。
 *
 * 这里踩过一次：切换公司的响应只写了 userId/organizationId/role/sessionId，
 * 漏了 `permissions` 与 `dataScope`。契约校验在客户端直接抛错，
 * 表现却是「点了 Beta Travel，标题没变」——看着像下拉没点中，
 * 实际是响应不合格。用 schema.parse 构造，漂移会在这一行炸掉。
 */
const fixtureMemberships = meResponseSchema.parse({
  userId: 'user-fixture',
  memberships: [
    { organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'admin' },
    { organizationId: 'org-beta', organizationName: 'Beta Travel', role: 'operator' },
  ],
});

/** Beta 是 operator：能读客户与订单、能开单，但不能管成员，数据范围只看自己。 */
const betaContext = authContextSchema.parse({
  userId: 'user-fixture',
  organizationId: 'org-beta',
  role: 'operator',
  sessionId: 'session-fixture',
  permissions: ['customer.read', 'order.read', 'order.write'],
  dataScope: 'own',
});

test.beforeEach(async ({ page }) => {
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
      body: JSON.stringify(fixtureMemberships),
    }),
  );
  await page.route('**/api/organizations/org-beta/switch', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(betaContext),
    }),
  );
});

test('redirects unauthenticated visitors to login', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
});

test('logs in, switches organization context, and signs out', async ({ page }) => {
  const selectedContextHeaders: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/me')) {
      selectedContextHeaders.push(request.headers()['x-organization-id'] ?? '');
    }
  });

  await page.goto('/login');
  await page.getByLabel('邮箱').fill('staff@example.test');
  await page.getByLabel('密码').fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Alpha Travel' })).toBeVisible();

  // 顶部公司选择器是 antd 的受控下拉，不是原生 <select>：必须点开再选项。
  // 点容器而不是内部 input：那一层被选中的文字盖住，点 input 会被判定为「元素被拦截」。
  await page.locator('.account-tools .ant-select').click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: 'Beta Travel' })
    .click();
  await expect(page.getByRole('heading', { name: 'Beta Travel' })).toBeVisible();
  await expect.poll(() => selectedContextHeaders).toContain('org-beta');

  await page.getByRole('button', { name: /退出登录/ }).click();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
});

test('mounts the configured CAPTCHA and enables login after verification', async ({ page }) => {
  test.skip(
    !process.env.VITE_SUPABASE_CAPTCHA_SITE_KEY,
    'Set a public test CAPTCHA site key to run the widget integration test.',
  );

  await page.addInitScript(() => {
    const browserWindow = window as unknown as {
      turnstile: {
        render(
          host: HTMLElement,
          options: { sitekey: string; callback(token: string): void },
        ): number;
        remove(id: number): void;
      };
    };
    browserWindow.turnstile = {
      render(host, options) {
        host.textContent = 'CAPTCHA fixture rendered';
        options.callback('captcha-fixture-token');
        return 1;
      },
      remove() {},
    };
  });

  await page.goto('/login');

  await expect(page.locator('.auth-captcha')).toBeVisible();
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeEnabled();
  await page.getByLabel('邮箱').fill('staff@example.test');
  await page.getByLabel('密码').fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL('/');
});
