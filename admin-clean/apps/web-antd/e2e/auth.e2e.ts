import { expect, test } from '@playwright/test';

import { fulfillJson, installAuthStub, signIn } from './support/session';

/**
 * 认证骨架的回归用例。
 *
 * 覆盖四件事，全部是「页面白屏 / 跳错地方」这一类线上真会出的事故：
 * 1. 未登录访问业务页要被拦到登录页，并记住原来要去哪；
 * 2. 登录成功后回到原来那一页（落点由路由守卫的 `redirectPath` 决定，
 *    不是 `authLogin` 的 `router.push(homePath)`——两处都写会让口径分叉）；
 * 3. 刷新/再次访问登录页时，已登录会话从 sessionStorage 恢复；
 * 4. 登出后本地会话被清干净，业务页重新被拦回登录页。
 */

test('未登录访问业务页 → 登录页并带上回跳目标', async ({ page }) => {
  await installAuthStub(page);

  await page.goto('/customer/list');

  await expect(page).toHaveURL(/\/auth\/login\?/);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('redirect'))
    .toBe('/customer/list');
  await expect(page.getByRole('button', { name: 'login' })).toBeVisible();
});

test('登录后回到原目标页，而不是一律回首页', async ({ page }) => {
  await installAuthStub(page);

  // 6 页全迁后占位路由归零，不再依赖「待实现」文案做落点断言。
  // 用真实客户列表页，补上它会发的业务桩，断言 URL + 真实正文。
  await page.route('**/api/customers**', (route) => {
    fulfillJson(route, { items: [], total: 0 });
  });
  // 客户页还会拉标签与来源下拉，不桩就漏到真网络。
  await page.route('**/api/customer-tags**', (route) => {
    fulfillJson(route, { tags: [] });
  });
  await page.route('**/api/customer-sources**', (route) => {
    fulfillJson(route, { sources: [] });
  });
  await page.goto('/customer/list');
  await expect(page.getByRole('button', { name: 'login' })).toBeVisible();

  await signIn(page);

  await expect(page).toHaveURL('/customer/list');
  // Vben 的 Page 标题不是 heading 角色，用页面正文里的描述文案断言更稳。
  await expect(page.getByText('维护客户基础资料与标签')).toBeVisible();
});

test('没有回跳目标时落到首页', async ({ page }) => {
  await installAuthStub(page);

  await page.goto('/auth/login');
  await signIn(page);

  await expect(page).toHaveURL('/workbench');
  // 工作台已是真实页面（阶段 3.1），不再是占位页。
  await expect(page.getByRole('heading', { name: 'Alpha Travel' })).toBeVisible();
});

test('刷新后会话仍有效，访问登录页会被送回首页', async ({ page }) => {
  await installAuthStub(page);

  await page.goto('/auth/login');
  await signIn(page);
  await expect(page).toHaveURL('/workbench');

  // 整页重载：store 内存态全丢，只能靠 sessionStorage 里的会话恢复。
  await page.goto('/auth/login');

  await expect(page).toHaveURL('/workbench');
});

test('登出后清空本地会话，业务页再次被拦回登录页', async ({ page }) => {
  await installAuthStub(page);

  await page.goto('/auth/login');
  await signIn(page);
  await expect(page).toHaveURL('/workbench');

  // 用户菜单的登出带二次确认；Alt+Q 是 Vben 内置的登出快捷键，直接打开确认框。
  // 按钮可访问名是「确 认」（antd 会在两个汉字之间插空格），必须用正则匹配。
  await page.keyboard.press('Alt+q');
  await page.getByRole('button', { name: /确\s*认/ }).click();

  // `logout(false)`：不写回跳参数，登录页就是干净的一页。
  await expect(page).toHaveURL(/\/auth\/login$/);

  await page.goto('/customer/list');
  await expect(page).toHaveURL(/\/auth\/login\?/);
});
