import { expect, test } from '@playwright/test';

const supabaseUrl = process.env.SMOKE_SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.SMOKE_SUPABASE_PUBLISHABLE_KEY;
const email = process.env.SMOKE_USER_EMAIL;
const password = process.env.SMOKE_USER_PASSWORD;
const organizationId = process.env.SMOKE_ORGANIZATION_ID;
const nonmemberOrganizationId = process.env.SMOKE_NONMEMBER_ORGANIZATION_ID;
const hasRealAuthFixture = Boolean(
  supabaseUrl && publishableKey && email && password && organizationId && nonmemberOrganizationId,
);

test('Worker serves the SPA and reports health dependency status with a request ID', async ({
  page,
  request,
}) => {
  const health = await request.get('/api/health');
  const body = await health.json();

  expect(health.headers()['x-request-id']).toBeTruthy();
  expect(body).toMatchObject({
    version: expect.any(String),
    requestId: health.headers()['x-request-id'],
    dependencies: {
      supabase: expect.stringMatching(/^(available|unavailable|missing_configuration)$/),
    },
  });
  const ready = Object.values(body.dependencies).every((state) => state === 'available');
  expect(health.status()).toBe(ready ? 200 : 503);

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
});

test('Worker rejects unauthenticated API requests with the standard error contract', async ({
  request,
}) => {
  const response = await request.get('/api/me');
  expect(response.status()).toBe(401);
  expect(response.headers()['x-request-id']).toBeTruthy();
  await expect(response.json()).resolves.toMatchObject({
    code: 'AUTH_REQUIRED',
    requestId: response.headers()['x-request-id'],
  });
});

test('real login selects an organization and RLS hides a nonmember organization', async ({
  page,
}) => {
  test.skip(
    !hasRealAuthFixture,
    'Set dedicated SMOKE_* test credentials and organization IDs to run the real Supabase chain.',
  );

  let bearerToken = '';
  page.on('request', (request) => {
    if (request.url().endsWith('/api/me')) bearerToken = request.headers().authorization ?? '';
  });

  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email!);
  await page.getByLabel('密码').fill(password!);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel('当前公司')).toBeVisible();
  await expect.poll(() => bearerToken).toMatch(/^Bearer\s+\S+$/);

  const selectedContextRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/me') &&
      request.headers()['x-organization-id'] === organizationId,
  );
  await page.getByLabel('当前公司').selectOption(organizationId!);
  await selectedContextRequest;

  const selectedMemberList = await page.request.get(
    `/api/organizations/${encodeURIComponent(organizationId!)}/members`,
    { headers: { Authorization: bearerToken, 'X-Organization-ID': organizationId! } },
  );
  expect(selectedMemberList.status()).toBe(200);

  const deniedSwitch = await page.request.post(
    `/api/organizations/${encodeURIComponent(nonmemberOrganizationId!)}/switch`,
    {
      headers: {
        Authorization: bearerToken,
        'X-Organization-ID': organizationId!,
      },
    },
  );
  expect(deniedSwitch.status()).toBe(403);

  const selectedRlsRead = await page.request.get(
    `${supabaseUrl}/rest/v1/organizations?select=id&id=eq.${encodeURIComponent(organizationId!)}`,
    {
      headers: {
        apikey: publishableKey!,
        Authorization: bearerToken,
        'X-Organization-ID': organizationId!,
      },
    },
  );
  expect(selectedRlsRead.status()).toBe(200);
  await expect(selectedRlsRead.json()).resolves.toEqual([{ id: organizationId }]);

  const directRlsRead = await page.request.get(
    `${supabaseUrl}/rest/v1/organizations?select=id&id=eq.${encodeURIComponent(nonmemberOrganizationId!)}`,
    {
      headers: {
        apikey: publishableKey!,
        Authorization: bearerToken,
        'X-Organization-ID': nonmemberOrganizationId!,
      },
    },
  );
  expect(directRlsRead.status()).toBe(200);
  await expect(directRlsRead.json()).resolves.toEqual([]);
});
