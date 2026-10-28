import { expect, test } from '@playwright/test';

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

const memberships = [
  { organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'admin' },
  { organizationId: 'org-beta', organizationName: 'Beta Travel', role: 'operator' },
];

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
      body: JSON.stringify({ userId: 'user-fixture', memberships }),
    }),
  );
  await page.route('**/api/organizations/org-beta/switch', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'user-fixture',
        organizationId: 'org-beta',
        role: 'operator',
        sessionId: 'session-fixture',
      }),
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
  await page.getByRole('button', { name: '登录' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Alpha Travel' })).toBeVisible();

  await page.getByLabel('当前公司').selectOption('org-beta');
  await expect(page.getByRole('heading', { name: 'Beta Travel' })).toBeVisible();
  await expect.poll(() => selectedContextHeaders).toContain('org-beta');

  await page.getByRole('button', { name: '退出登录' }).click();
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
  await expect(page.getByRole('button', { name: '登录' })).toBeEnabled();
  await page.getByLabel('邮箱').fill('staff@example.test');
  await page.getByLabel('密码').fill('fixture-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL('/');
});
