import { expect, test } from '@playwright/test';
import {
  adminUser,
  createStubState,
  installApiStub,
  operatorUser,
} from './support/api-stub';
import { buttonName, closeDrawer, descriptionItem, goTo, signIn } from './support/session';

/**
 * 收付款主线：登录 → 订单列表 → 订单详情金额行 → 发起收款申请 → 审批通过 → 金额从在途转已收。
 *
 * 两个身份、两个浏览器上下文，因为「提交人不能审批自己的申请」是业务规则而不是可选项。
 * 桩里也照这条规则拒绝，否则这条用例会在真实系统做不到的路径上变绿。
 *
 * 这里证明的是**前端渲染与交互**：请求确实发出、字段正确、界面按服务端返回的钱数变化。
 * 服务端行为（RLS、库函数的行锁、事务）由 pgTAP 与 HTTP 集成测试负责，不在本文件。
 */
test('计调报款 → 财务一审 → 管理员终审：金额从在途转为已收', async ({ browser }) => {
  // 两个身份、两次首屏编译（vite dev 按需转译）加十几个断言，30 秒的默认值不够。
  test.setTimeout(120_000);
  const state = createStubState();
  const operatorContext = await browser.newContext();
  const adminContext = await browser.newContext();

  try {
    const operatorPage = await operatorContext.newPage();
    const operatorStub = await installApiStub(operatorPage, { state, user: operatorUser() });
    await signIn(operatorPage, operatorUser());
    await goTo(operatorPage, '订单');

    const listRow = operatorPage.locator('.ant-table-row').filter({ hasText: 'ORD-2026-0011' });
    await expect(listRow).toContainText('¥12,000.00');
    // 未收 = 应收合计 − 已确认 = 12,000 − 4,000
    await expect(listRow).toContainText('¥8,000.00');

    await listRow.getByRole('button', { name: 'ORD-2026-0011' }).click();
    await expect(operatorPage.locator('.ant-drawer-open')).toHaveCount(1);

    // 财务摘要全部来自服务端：已收 4,000、未收 8,000、在途 0
    await expect(descriptionItem(operatorPage, '已收 / 未收')).toContainText('¥4,000.00');
    await expect(descriptionItem(operatorPage, '已收 / 未收')).toContainText('¥8,000.00');
    await expect(descriptionItem(operatorPage, '在途收款')).toContainText('¥0.00');
    await expect(descriptionItem(operatorPage, '可申请应收余额')).toContainText('¥8,000.00');

    const receivableRow = operatorPage.locator('.ant-table-row').filter({ hasText: '团款' });
    await expect(receivableRow).toContainText('¥8,000.00');
    await receivableRow.getByRole('button', { name: '申请收款' }).click();

    await operatorPage.getByPlaceholder('不超过该行可申请余额').fill('3000');
    await operatorPage.getByRole('button', { name: '提交申请' }).click();

    // 请求体直接对契约：金额、订单、明细行都不能选错
    await expect
      .poll(() => operatorStub.requestsTo('POST', '/api/finance-applications').length)
      .toBe(1);
    expect(operatorStub.requestsTo('POST', '/api/finance-applications')[0]?.body).toMatchObject({
      kind: 'receipt',
      orderId: 'order-1',
      lineId: 'receivable-1',
      amount: 3000,
    });

    // 提交后回读：3,000 进在途，可申请余额从 8,000 掉到 5,000
    await expect(descriptionItem(operatorPage, '在途收款')).toContainText('¥3,000.00');
    await expect(descriptionItem(operatorPage, '可申请应收余额')).toContainText('¥5,000.00');
    await expect(receivableRow).toContainText('¥3,000.00');
    await expect(receivableRow).toContainText('¥5,000.00');

    await closeDrawer(operatorPage);
    // 在途不算已收：列表的「未收」不该因为提交了申请而变小
    await operatorPage.getByRole('button', { name: buttonName('刷新') }).click();
    await expect(listRow).toContainText('¥8,000.00');

    const adminPage = await adminContext.newPage();
    const adminStub = await installApiStub(adminPage, { state, user: adminUser() });
    await signIn(adminPage, adminUser());
    await goTo(adminPage, '审批');

    const applicationRow = adminPage.locator('.ant-table-row').filter({ hasText: 'ORD-2026-0011' });
    await expect(applicationRow).toContainText('¥3,000.00');
    await expect(applicationRow).toContainText('待财务审批');

    // 一审通过：级次推进，钱还没入账
    await applicationRow.getByRole('button', { name: buttonName('通过') }).click();
    await adminPage.locator('.ant-modal').getByRole('button', { name: buttonName('通过') }).click();
    await expect(applicationRow).toContainText('待管理员终审');

    await listRow.getByRole('button', { name: 'ORD-2026-0011' }).click();
    await expect(descriptionItem(operatorPage, '在途收款')).toContainText('¥3,000.00');
    await expect(descriptionItem(operatorPage, '已收 / 未收')).toContainText('¥4,000.00');
    await closeDrawer(operatorPage);

    // 终审通过：在途 3,000 转成已收，已收 4,000 → 7,000，未收 8,000 → 5,000
    await applicationRow.getByRole('button', { name: buttonName('通过') }).click();
    await adminPage.locator('.ant-modal').getByRole('button', { name: buttonName('通过') }).click();
    // 默认筛选是「待审批」：终审通过后这条就该离开待审列表
    await expect(adminPage.locator('.result-count')).toContainText('共 0 条申请');

    await operatorPage.getByRole('button', { name: buttonName('刷新') }).click();
    await expect(listRow).toContainText('¥5,000.00');
    await listRow.getByRole('button', { name: 'ORD-2026-0011' }).click();
    await expect(descriptionItem(operatorPage, '已收 / 未收')).toContainText('¥7,000.00');
    await expect(descriptionItem(operatorPage, '已收 / 未收')).toContainText('¥5,000.00');
    await expect(descriptionItem(operatorPage, '在途收款')).toContainText('¥0.00');
    await expect(descriptionItem(operatorPage, '可申请应收余额')).toContainText('¥5,000.00');

    expect(operatorStub.violations).toEqual([]);
    expect(adminStub.violations).toEqual([]);
  } finally {
    await operatorContext.close();
    await adminContext.close();
  }
});
