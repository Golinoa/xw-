/**
 * e2e 共用的登录/登出操作。
 *
 * 定位策略（不使用 CSS 层级、不使用固定等待）：
 * - 账号/密码输入框用 `autocomplete` 语义属性定位：表单标签在 UI 上是隐藏的
 *   （`hideLabel: true`），`autocomplete` 是登录页唯一稳定且语义正确的锚点；
 * - 提交按钮用库自带的 `aria-label="login"`；
 * - 菜单项/下拉项用 role 定位，避免依赖 antd/reka 的 DOM 结构。
 */
import type { Page } from '@playwright/test';

import { expect } from '@playwright/test';

/** 契约桩唯一账号（`src/api/ops/__stub__/fixtures.ts` 的 STUB_CREDENTIALS）。 */
export const STUB_ACCOUNT = { password: 'stub', username: 'stub' } as const;

/** 契约桩条幅：只要桩启用就必然存在，用于确认「本次跑的是桩而非真实后端」。 */
export function stubBanner(page: Page) {
  return page.locator('#ops-dev-stub-banner');
}

export function usernameInput(page: Page) {
  return page.locator('input[autocomplete="username"]');
}

export function passwordInput(page: Page) {
  return page.locator('input[autocomplete="current-password"]');
}

export function submitButton(page: Page) {
  return page.getByRole('button', { name: 'login' });
}

/** 填表并提交，不做任何结果断言（由调用方决定期望）。 */
export async function submitLogin(
  page: Page,
  account: { password?: string; username?: string },
): Promise<void> {
  await usernameInput(page).fill(account.username ?? '');
  await passwordInput(page).fill(account.password ?? '');
  await submitButton(page).click();
}

/** 以契约桩账号登录，并断言已落到默认首页。 */
export async function loginAsStub(page: Page): Promise<void> {
  await page.goto('/auth/login');
  await expect(usernameInput(page)).toBeVisible();
  await submitLogin(page, STUB_ACCOUNT);
  await expect(page).toHaveURL(/\/overview$/);
}

/**
 * 通过右上角用户下拉登出。
 *
 * 三个不显然但稳定的细节：
 * 1. 用 focus + Enter 打开下拉，而不是 `click()`：开发态契约桩条幅是
 *    `position: fixed; z-index: 2147483647` 的顶部横条，会盖住头部按钮的中心点，
 *    指针点击会被条幅拦截（键盘激活不受影响，也是无障碍路径）；
 * 2. antd 确认按钮的 DOM 文本是「确 认」（两字按钮自动插空格），因此用正则容忍空白。
 */
export async function logoutViaUserMenu(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: /演示运营/ });
  await trigger.focus();
  await trigger.press('Enter');
  const logoutItem = page.getByRole('menuitem', { name: /退出登录/ });
  await expect(logoutItem).toBeVisible();
  // 用 force 点击：下拉内容在 headless 下持续动画，Playwright 的「元素稳定」判据
  // 会一直等到超时；这里仍走真实指针事件，只跳过稳定性/命中测试。
  await logoutItem.click({ force: true });
  await page.getByRole('button', { name: /确\s*认/ }).click();
  await expect(page).toHaveURL(/\/auth\/login/);
}
