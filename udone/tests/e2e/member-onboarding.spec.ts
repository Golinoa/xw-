import { expect, test } from '@playwright/test';

const invitedSession = {
  access_token: 'invited-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'invited-refresh-token',
  user: {
    id: 'invited-user',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'invitee@example.test',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: '2026-10-05T00:00:00.000Z',
  },
};

test('shows a non-enumerating result when requesting password recovery', async ({ page }) => {
  await page.route('**/auth/v1/recover*', (route) => route.fulfill({ status: 200, body: '' }));

  await page.goto('/login');
  await page.getByRole('button', { name: '忘记密码？' }).click();
  await page.getByLabel('邮箱').fill('unknown@example.test');
  await page.getByRole('button', { name: '发送重置邮件' }).click();

  await expect(page.getByText('如果该邮箱已注册，我们会发送密码重置邮件。')).toBeVisible();
});

test('accepts a valid invitation after the first sign-in has no active membership', async ({
  page,
}) => {
  await page.route('**/auth/v1/token*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(invitedSession),
    }),
  );
  let membershipRequests = 0;
  await page.route('**/api/me', (route) => {
    membershipRequests += 1;
    if (membershipRequests === 1)
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Authentication is required' } }),
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'invited-user',
        memberships: [
          { organizationId: 'org-accepted', organizationName: 'Accepted Org', role: 'operator' },
        ],
      }),
    });
  });
  await page.route('**/api/invitations/invite-accepted/accept', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ membership: { organizationId: 'org-accepted', role: 'operator' } }),
    }),
  );

  await page.goto('/login?invitationId=invite-accepted');
  await page.getByLabel('邮箱').fill('invitee@example.test');
  await page.getByLabel('密码').fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Accepted Org' })).toBeVisible();
  await expect.poll(() => membershipRequests).toBeGreaterThanOrEqual(2);
});

test('lets an organization admin create an invitation and shows its pending expiry', async ({
  page,
}) => {
  await page.route('**/auth/v1/token*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...invitedSession,
        user: { ...invitedSession.user, email: 'admin@example.test' },
      }),
    }),
  );
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'invited-user',
        memberships: [
          { organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'admin' },
        ],
      }),
    }),
  );
  await page.route('**/api/organizations/org-alpha/invitations', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        invitation: {
          id: 'invite-pending',
          status: 'pending',
          expiresAt: '2026-10-12T00:00:00.000Z',
        },
      }),
    }),
  );

  await page.goto('/login');
  await page.getByLabel('邮箱').fill('admin@example.test');
  await page.getByLabel('密码').fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.getByLabel('邀请邮箱').fill('new-staff@example.test');
  await page.getByRole('button', { name: '发送邀请' }).click();

  await expect(page.getByRole('status')).toContainText('pending');
  await expect(page.getByRole('status')).toContainText('2026');
});
