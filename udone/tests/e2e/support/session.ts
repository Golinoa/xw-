import { expect, type Page } from '@playwright/test';
import type { StubUser } from './api-stub';

/**
 * 登录走真实表单，只有 `/auth/v1/token` 被桩接住。
 *
 * 刻意不往 localStorage 里塞会话：那样会绕开 `applySession` 与路由守卫，
 * 用例就无法证明「未登录会被挡在登录页」与「登录后会拿到公司上下文」。
 */
export async function signIn(page: Page, user: StubUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(user.email);
  await page.getByLabel('密码').fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page.getByRole('heading', { name: user.organizationName })).toBeVisible();
}

/** 顶部导航跳转。用链接而不是 `goto`，避免整页重载后重新走一遍 Supabase 会话恢复。 */
export async function goTo(page: Page, name: '订单' | '审批'): Promise<void> {
  await page.getByRole('link', { name, exact: true }).click();
}

/**
 * 详情抽屉/描述列表里的单个字段值。
 *
 * ant-design-vue 的 Descriptions 渲染成 `<th>标签</th><td>值</td>` 同级结构，
 * 没有包一层的 `.ant-descriptions-item`。所以取「标签的兄弟 td」，
 * 而不是整行：一行里有两对标签与值，按行断言会把「已收」和「已付」的数字混为一谈。
 */
export function descriptionItem(page: Page, label: string) {
  return page
    .locator('th.ant-descriptions-item-label')
    .filter({ hasText: label })
    .locator('xpath=following-sibling::td[1]');
}

/**
 * 关闭详情抽屉。
 *
 * 用右上角关闭按钮，不用 Escape：抽屉只在焦点位于自身时才响应 Esc，
 * 而「提交完申请弹窗」之后焦点已经不在抽屉里了——按 Esc 什么都不发生，
 * 用例会在下一步悄悄对着一个仍然打开的面板做断言。
 */
export async function closeDrawer(page: Page): Promise<void> {
  await page.locator('.ant-drawer-close').click();
  await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
}

/**
 * 按钮名匹配器。
 *
 * ant-design-vue 会给**两个汉字**的按钮文案中间插一个空格（「刷新」→「刷 新」），
 * 这是它的排版规则，不是本项目的模板写错。写死 `'刷新'` 的用例会永远找不到按钮，
 * 所以按钮名一律用这个函数生成，逐字之间容忍空白。
 */
export function buttonName(label: string): RegExp {
  return new RegExp(`^${label.split('').map(escapeRegExp).join('\\s*')}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
