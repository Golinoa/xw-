/**
 * 有权限域的菜单与页面可见性 —— **契约桩验证**。
 *
 * 桩账号（`src/api/ops/__stub__/fixtures.ts`）授予 `OPS_PERMISSION_CODES` 全量动作码，
 * 因此本文件只验证「具备动作码 → 菜单可见 / 页面可进入 / 动作按钮可见」这一侧；
 * 「权限子集 → 菜单不可见 + 直达 404」在 `e2e/http/permission.spec.ts` 覆盖。
 */
import { expect, test } from '@playwright/test';

import { loginAsStub } from '../support/auth';

test.describe('权限呈现（契约桩）', () => {
  test('具备 customer.read → 客户菜单可见且列表页可进入', async ({ page }) => {
    await loginAsStub(page);

    // 一级菜单（子菜单标题）可见
    const customerNav = page.getByText('客户管理', { exact: true });
    await expect(customerNav).toBeVisible();

    // 展开后二级菜单项可见（未展开时子项被 v-show 隐藏，不能直接断言）
    await customerNav.click();
    const customerList = page.getByRole('menuitem', {
      name: '软件客户与联系人',
    });
    await expect(customerList).toBeVisible();

    await customerList.click();
    await expect(page).toHaveURL(/\/customers\/list$/);

    // 页面按动作码呈现写入入口（customer.write 已授予）
    await expect(page.getByRole('button', { name: '新建客户' })).toBeVisible();
    // 数据来自前端虚构样例，页面必须自报来源
    await expect(
      page.getByText('开发态数据（VITE_OPS_MOCK=true）'),
    ).toBeVisible();
  });
});
