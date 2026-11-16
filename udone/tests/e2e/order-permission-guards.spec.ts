import { expect, test } from '@playwright/test';
import {
  createStubState,
  financeUser,
  installApiStub,
  seedPendingApplication,
} from './support/api-stub';
import { buttonName, descriptionItem, goTo, signIn } from './support/session';

/**
 * 两条只在前端成立的守卫：按钮不该出现，驳回不该被空意见放行。
 *
 * 它们都是「服务端也会拦，但让用户点完再被拒」的形态——所以必须断言**没有发请求**，
 * 而不只是断言界面上出现了一句错误文案。
 */
test('财务角色看不到订单写入口，但能看到报款与审批入口', async ({ page }) => {
  const stub = await installApiStub(page, { state: createStubState(), user: financeUser() });
  await signIn(page, financeUser());
  await goTo(page, '订单');

  const listRow = page.locator('.ant-table-row').filter({ hasText: 'ORD-2026-0011' });
  await expect(listRow).toBeVisible();
  // finance 没有 order.write：新建订单不能出现（刷新是读操作，应该在）
  await expect(page.getByRole('button', { name: '新建订单' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: buttonName('刷新') })).toBeVisible();

  await listRow.getByRole('button', { name: 'ORD-2026-0011' }).click();
  await expect(descriptionItem(page, '已收 / 未收')).toContainText('¥4,000.00');
  // 编辑与状态迁移都挂在 order.write 上，同样不该出现
  await expect(page.getByRole('button', { name: buttonName('编辑') })).toHaveCount(0);
  await expect(page.getByRole('button', { name: buttonName('锁团') })).toHaveCount(0);
  // 报款是 finance.write，与订单编辑是两件事
  await expect(page.getByRole('button', { name: '申请收款' })).toHaveCount(1);
  expect(stub.violations).toEqual([]);
});

test('驳回未填意见时提交前被拦下，填了原因才发出请求', async ({ page }) => {
  const state = createStubState();
  // 版本号先取快照：下面的对象是桩里的同一个引用，审批成功后会自增。
  const approvedVersion = seedPendingApplication(state, { amount: 2500 }).version;
  const stub = await installApiStub(page, { state, user: financeUser() });
  await signIn(page, financeUser());
  await goTo(page, '审批');

  const row = page.locator('.ant-table-row').filter({ hasText: 'ORD-2026-0011' });
  await expect(row).toContainText('¥2,500.00');
  await expect(row).toContainText('待财务审批');

  await row.getByRole('button', { name: buttonName('驳回') }).click();
  const modal = page.locator('.ant-modal');
  await modal.getByRole('button', { name: buttonName('确认') }).click();

  await expect(modal.getByText('驳回必须填写原因')).toBeVisible();
  // 关键：一次 PATCH 都不该发出去。只断言文案会让「发了请求再显示错误」也通过。
  expect(stub.requestsTo('PATCH', '/api/finance-applications')).toHaveLength(0);

  await modal.locator('textarea').fill('金额与合同附件不一致');
  await modal.getByRole('button', { name: buttonName('确认') }).click();

  await expect.poll(() => stub.requestsTo('PATCH', '/api/finance-applications').length).toBe(1);
  expect(stub.requestsTo('PATCH', '/api/finance-applications')[0]?.body).toMatchObject({
    action: 'reject',
    opinion: '金额与合同附件不一致',
    version: approvedVersion,
  });

  // 默认筛选是「待审批」：驳回后这条就该从待审列表消失（不是留在原地显示旧状态）
  await expect(page.locator('.result-count')).toContainText('共 0 条申请');
  // 换到「已驳回」再确认一次：驳回真的落库了，不是界面把行藏起来了
  await page.locator('.filter-card .ant-select').first().click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: '已驳回' })
    .click();
  await expect(page.locator('.result-count')).toContainText('共 1 条申请');
  await expect(page.locator('.ant-table-row').filter({ hasText: 'ORD-2026-0011' })).toContainText(
    '已驳回',
  );
  expect(stub.violations).toEqual([]);
});
