import { expect, test } from '@playwright/test';
import { adminUser, createStubState, installApiStub } from './support/api-stub';
import { buttonName, goTo, signIn } from './support/session';

/**
 * 订单列表的两种「没有数据」必须在界面上长得不一样。
 *
 * 这是本卡最容易被实现成假绿的一处：空列表与请求失败如果都渲染成「暂无订单」，
 * 用户会把一次故障理解为「系统里确实没有订单」，然后去重录一遍。
 */
test('空列表显示引导文案，而不是错误态', async ({ page }) => {
  const stub = await installApiStub(page, {
    state: createStubState({ emptyOrderList: true }),
    user: adminUser(),
  });
  await signIn(page, adminUser());
  await goTo(page, '订单');

  await expect(page.getByText('共 0 个订单')).toBeVisible();
  // 有写权限时给出下一步动作，而不是一句「暂无数据」
  await expect(page.locator('tr.ant-table-placeholder')).toContainText(
    '暂无订单，点击右上角「新建订单」开始录入',
  );
  await expect(page.locator('.ant-alert')).toHaveCount(0);
  expect(stub.violations).toEqual([]);
});

test('列表请求失败时给出可读错误与重试，重试后恢复', async ({ page }) => {
  const state = createStubState({ failOrderList: true });
  const stub = await installApiStub(page, { state, user: adminUser() });
  await signIn(page, adminUser());
  await goTo(page, '订单');

  // 5xx 会被 api-client 自动重试 3 次，所以这里的等待时间要够宽
  await expect(
    page.getByText('列表请求没有成功，当前页面没有任何订单数据；这不代表系统中没有订单。'),
  ).toBeVisible({ timeout: 15_000 });
  // 失败态不能退化成空态：一句「暂无订单」会让故障看起来像「本来就没数据」
  await expect(page.locator('tr.ant-table-placeholder')).toHaveCount(0);

  state.failOrderList = false;
  await page
    .locator('.ant-alert')
    .getByRole('button', { name: buttonName('重试') })
    .click();
  await expect(page.locator('.ant-table-row').filter({ hasText: 'ORD-2026-0011' })).toBeVisible();
  expect(stub.violations).toEqual([]);
});
