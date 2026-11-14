/**
 * 无权限路由呈现口径 —— **契约回放验证**（非真实后端集成）。
 *
 * 口径（`src/router/access.ts`、`src/router/guard.ts`）：无权限路由整棵不注册，
 * 菜单不可见；直接输入 URL 命中原生 404 兜底，文案同时覆盖「不存在」与「无权访问」，
 * 不把资源是否存在泄露成 403。
 *
 * 为什么用 HTTP 回放而不是应用内桩：桩固定授予全部动作码，无法构造权限子集。
 */
import { expect, test } from '@playwright/test';

import { submitLogin } from '../support/auth';
import { gotoInSession, installOpsContract } from './ops-contract';

const RESTRICTED_ACCOUNT = {
  password: 'e2e-contract',
  username: 'ops.restricted@example.invalid',
};

test.describe('无权限路由（契约回放）', () => {
  test('仅 customer.read：客户菜单可见，账款菜单不可见，直达 URL 落 404', async ({
    page,
  }) => {
    await installOpsContract(page, {
      permissions: ['overview.read', 'customer.read'],
    });

    await page.goto('/auth/login');
    await submitLogin(page, RESTRICTED_ACCOUNT);
    await expect(page).toHaveURL(/\/overview$/);

    // 有权限的域：菜单可见
    await expect(page.getByText('客户管理', { exact: true })).toBeVisible();

    // 无权限的域：连菜单项都不生成（不是「置灰」）
    await expect(page.getByText('账款管理', { exact: true })).toHaveCount(0);

    // 直接输入 URL：落 404 兜底，且文案不区分「不存在」与「无权访问」
    await gotoInSession(page, '/billing/receivables');
    await expect(page).toHaveURL(/\/billing\/receivables$/);
    await expect(page.getByText('页面不存在或无权访问')).toBeVisible();
    // 不复用 403 文案，避免泄露资源是否存在
    await expect(page.getByText('无访问权限', { exact: true })).toHaveCount(0);
  });
});
