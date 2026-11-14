/**
 * 登录 / 登出 / 守卫 —— **契约桩验证**。
 *
 * 运行前置：Playwright 以 `VITE_OPS_MOCK=true` 启动 dev server（端口 5666），
 * 会话数据来自 `src/api/ops/__stub__/fixtures.ts` 的虚构数据，后端未接入。
 * 本文件证明的是「前端会话状态机与路由守卫的可观察行为」，**不是**真实后端集成验收。
 */
import { expect, test } from '@playwright/test';

import {
  loginAsStub,
  logoutViaUserMenu,
  passwordInput,
  submitButton,
  submitLogin,
  usernameInput,
} from '../support/auth';

test.describe('登录与会话（契约桩）', () => {
  test('正确凭据 → 进入默认首页 /overview', async ({ page }) => {
    await page.goto('/auth/login');
    await submitLogin(page, { password: 'stub', username: 'stub' });

    await expect(page).toHaveURL(/\/overview$/);
    // 页面标题必须是译后的中文，不能是 i18n key。
    // 回归背景：路由模块经 `import.meta.glob({ eager: true })` 静态引入，早于
    // `setupI18n()`，`meta.title` 拿到的是 key；占位页曾直接渲染 `meta.title`，
    // 导致页面标题显示 `ops-shell.nav.overview`。已在 placeholder-page.vue 显式翻译。
    await expect(
      page.getByRole('heading', { level: 2, name: '运营总览' }),
    ).toBeVisible();
    await expect(page.getByText('ops-shell.nav.overview')).toHaveCount(0);
    // 首页已从占位页换成真实总览（identity-audit 域）：断言统计时刻与分币种区块存在，
    // 并确认占位文案消失——避免「占位页悄悄回来了」这类回归。
    await expect(page.getByText('统计时刻：')).toBeVisible();
    await expect(page.getByText('应收按币种')).toBeVisible();
    await expect(
      page.getByText(
        '该页面将在后续迭代中实现，当前仅提供路由入口与菜单契约。',
      ),
    ).toHaveCount(0);
    // 桩启用时页面顶部必须出现「开发态契约桩」提示，避免被误当成真实集成
    await expect(page.locator('#ops-dev-stub-banner')).toBeVisible();
  });

  test('错误凭据 → 登录页内联可读错误，不产生会话', async ({ page }) => {
    await page.goto('/auth/login');
    await submitLogin(page, { password: 'wrong-password', username: 'stub' });

    const error = page.getByTestId('login-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('账号或密码错误');
    // 仍在登录页，且输入内容没有被清空（可重试）
    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(usernameInput(page)).toHaveValue('stub');

    // 未获得会话：直接访问受保护路由仍会被送回登录页
    await page.goto('/overview');
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('未登录访问受保护路由 → 重定向登录并携带 redirect', async ({ page }) => {
    await page.goto('/customers/list');
    await expect(page).toHaveURL(/\/auth\/login\?redirect=/);

    // 守卫把原地址写进 redirect（`encodeURIComponent` + vue-router 再次编码，
    // 因此原始 query 是双层编码）。这里断言「解码后等于原路径」，与编码层数解耦。
    const redirect = new URL(page.url()).searchParams.get('redirect');
    expect(redirect).not.toBeNull();
    expect(decodeURIComponent(redirect ?? '')).toBe('/customers/list');

    await expect(usernameInput(page)).toBeVisible();
    await expect(passwordInput(page)).toBeVisible();
    await expect(submitButton(page)).toBeVisible();
  });

  test('登出 → 会话清理，再次访问受保护路由被拦截', async ({ page }) => {
    await loginAsStub(page);

    await logoutViaUserMenu(page);

    // 登出后回到登录页；再访问受保护路由仍会被拦住
    await page.goto('/customers/list');
    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(usernameInput(page)).toBeVisible();
  });
});
