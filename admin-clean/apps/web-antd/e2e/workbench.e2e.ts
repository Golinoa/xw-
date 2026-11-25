import { expect, test } from '@playwright/test';

import { installAuthStub, signIn } from './support/session';

/**
 * 工作台回归：它是第一个真正读业务身份（公司 + 角色）的页面。
 *
 * 三个断言各自对应一类真实事故：
 * 1. 公司/角色没渲染 → 迁移时把成员信息接到了别的字段上；
 * 2. 管理员看不到成员管理 → 权限判断写成了恒 false（或读错角色字段）；
 * 3. 无组织归属的账号被无限拦截 → 上一版把「没有成员记录」当成登录失败处理。
 */

test('管理员登录后工作台显示公司、角色与账号', async ({ page }) => {
  await installAuthStub(page);

  await page.goto('/auth/login');
  await signIn(page);

  await expect(page).toHaveURL('/workbench');
  await expect(page.getByRole('heading', { name: 'Alpha Travel' })).toBeVisible();
  await expect(page.getByTestId('workbench-role')).toHaveText('管理员');
  await expect(page.getByTestId('workbench-account')).toHaveText('staff@example.test');
});

test('管理员能看到成员与邀请面板', async ({ page }) => {
  await installAuthStub(page);

  await page.goto('/auth/login');
  await signIn(page);

  await expect(page.getByText('成员与邀请')).toBeVisible();
  await expect(page.getByLabel('invite-email')).toBeVisible();
});

test('业务操作员看不到成员与邀请面板', async ({ page }) => {
  await installAuthStub(page, {
    memberships: [{ organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'operator' }],
  });

  await page.goto('/auth/login');
  await signIn(page);

  await expect(page.getByTestId('workbench-role')).toHaveText('业务操作员');
  await expect(page.getByText('成员与邀请')).toHaveCount(0);
});

test('未加入任何公司的账号进到工作台并看到提示，而不是被踢出登录', async ({ page }) => {
  await installAuthStub(page, { memberships: [] });

  await page.goto('/auth/login');
  await signIn(page);

  await expect(page).toHaveURL('/workbench');
  await expect(page.getByTestId('no-membership')).toContainText('尚未加入公司');
});
