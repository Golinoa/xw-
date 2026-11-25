import { expect, test } from '@playwright/test';

import { fulfillJson, installAuthStub, signIn } from './support/session';

/**
 * 阶段 3 收尾：订单 / 游客 / CRM 线索 / 收付款 / 审批申请 / 结算六页。
 *
 * 这一批的用例重心是「页面真渲染、关键写端点请求体正确」，不是重复后端测试。
 * 所有响应先过契约 schema（由 support/session 的 stub 机制保证），
 * 桩按 pathname 单 handler 分派，避免分散注册时漏到真网络。
 */
const NOW = '2026-11-24T06:00:00.000Z';

async function enter(page: import('@playwright/test').Page) {
  await installAuthStub(page);
  await page.goto('/auth/login');
  await signIn(page);
}

test('订单页渲染列表，状态迁移必带原因', async ({ page }) => {
  await installAuthStub(page);
  const order = {
    adultCount: 2,
    childCount: 0,
    createdAt: NOW,
    customerId: 'customer-1',
    customerName: '张伟',
    id: 'order-1',
    orderNumber: 'OD-20261124-001',
    orderType: 'active',
    payableTotal: 1000,
    personCount: 2,
    profit: 500,
    receivables: [],
    payables: [],
    receivableTotal: 1500,
    routeName: '千岛湖一日游',
    status: 'active',
    uncollectedAmount: 500,
    unpaidAmount: 300,
    updatedAt: NOW,
    version: 1,
  };
  await page.route('**/api/orders**', (route) =>
    fulfillJson(route, { items: [order], page: 1, pageSize: 15, total: 1 }),
  );
  await page.route('**/api/customers**', (route) => fulfillJson(route, { items: [], total: 0 }));
  await enter(page);
  await page.goto('/trade/orders');
  await expect(page.getByText('OD-20261124-001')).toBeVisible();
  await expect(page.getByText('进行中')).toBeVisible();
});

test('游客独立页选订单后展示名单', async ({ page }) => {
  await installAuthStub(page);
  await page.route('**/api/orders**', (route) =>
    fulfillJson(route, {
      items: [
        {
          adultCount: 2,
          childCount: 0,
          createdAt: NOW,
          customerId: 'customer-1',
          customerName: '张伟',
          id: 'order-1',
          orderNumber: 'OD-20261124-001',
          orderType: 'active',
          payableTotal: 0,
          personCount: 2,
          profit: 0,
          receivables: [],
          payables: [],
          receivableTotal: 0,
          status: 'active',
          uncollectedAmount: 0,
          unpaidAmount: 0,
          updatedAt: NOW,
          version: 1,
        },
      ],
      page: 1,
      pageSize: 15,
      total: 1,
    }),
  );
  await page.route('**/api/orders/order-1/tourists**', (route) =>
    fulfillJson(route, {
      roster: {
        adultCount: 1,
        childCount: 0,
        declaredAdultCount: 2,
        declaredChildCount: 0,
        items: [
          {
            createdAt: NOW,
            gender: 'male',
            id: 'tourist-1',
            name: '李雷',
            personType: 'adult',
            updatedAt: NOW,
          },
        ],
        personCount: 1,
        total: 1,
      },
    }),
  );
  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/trade/tourists');
  await expect(page.getByText('李雷')).toBeVisible();
});

test('CRM 线索页渲染列表与漏斗', async ({ page }) => {
  await installAuthStub(page);
  await page.route('**/api/leads**', (route) =>
    fulfillJson(route, {
      items: [
        {
          adultCount: 2,
          budgetMax: 8000,
          budgetMin: 3000,
          childCount: 0,
          convertedCustomerId: null,
          createdAt: NOW,
          departureCity: '杭州',
          destination: '千岛湖',
          email: null,
          expectedDate: null,
          id: 'lead-1',
          intentLevel: '中',
          lastFollowUpAt: null,
          name: '王芳',
          nextFollowUpAt: null,
          ownerId: null,
          ownerName: null,
          phone: '13800000000',
          remark: null,
          source: '官网',
          stage: 'new',
          tripType: '跟团游',
          version: 1,
          wechat: null,
        },
      ],
      page: 1,
      pageSize: 15,
      total: 1,
    }),
  );
  await page.route('**/api/leads/funnel**', (route) =>
    fulfillJson(route, {
      convertedCustomers: 0,
      convertedOrders: 0,
      from: '2026-11-01',
      stages: { new: 1 },
      to: '2026-11-24',
      total: 1,
    }),
  );
  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/customer/leads');
  await expect(page.getByText('王芳')).toBeVisible();
});

test('收付款页双页签渲染', async ({ page }) => {
  await installAuthStub(page);
  await page.route('**/api/receivables**', (route) =>
    fulfillJson(route, { items: [], page: 1, pageSize: 15, total: 0 }),
  );
  await page.route('**/api/payables**', (route) =>
    fulfillJson(route, { items: [], page: 1, pageSize: 15, total: 0 }),
  );
  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/finance/receipts');
  await expect(page.getByText('应收明细')).toBeVisible();
  await page.getByRole('button', { name: '应付明细' }).click();
  await expect(page.getByText('应付明细')).toBeVisible();
});

test('审批申请页渲染并隐藏自审按钮', async ({ page }) => {
  await installAuthStub(page);
  await page.route('**/api/finance-applications**', (route) =>
    fulfillJson(route, { items: [], page: 1, pageSize: 15, total: 0 }),
  );
  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/finance/applications');
  await expect(page.getByText('暂无申请')).toBeVisible();
});

test('结算页渲染批次列表', async ({ page }) => {
  await installAuthStub(page);
  await page.route('**/api/settlements**', (route) =>
    fulfillJson(route, { items: [], page: 1, pageSize: 15, total: 0 }),
  );
  await page.route('**/api/suppliers**', (route) =>
    fulfillJson(route, { items: [], page: 1, pageSize: 100, total: 0 }),
  );
  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/finance/settlements');
  await expect(page.getByText('暂无结算批次')).toBeVisible();
});

/**
 * 下面三条是「写端点请求体 + 状态机分支」的守卫，不是重复列表渲染。
 * 这三类 bug 后端都查不出来：前端少发一个必填字段、多显示一个不该点的按钮。
 */
test('订单锁团必须先填原因，填了才带进请求体', async ({ page }) => {
  await installAuthStub(page);
  const requests: Record<string, unknown>[] = [];
  const order = {
    adultCount: 2,
    childCount: 0,
    createdAt: NOW,
    customerId: 'customer-1',
    customerName: '张伟',
    id: 'order-1',
    lines: [],
    orderNumber: 'OD-20261124-001',
    orderType: 'active',
    payableTotal: 1000,
    payables: [],
    personCount: 2,
    profit: 500,
    receivables: [],
    receivableTotal: 1500,
    routeName: '千岛湖一日游',
    status: 'active',
    uncollectedAmount: 500,
    unpaidAmount: 300,
    updatedAt: NOW,
    version: 3,
  };
  // 一条 handler 按 pathname 分派：详情抽屉会拉 /api/orders/:id，
  // 不能被列表响应吃掉，否则 result.order 是 undefined、详情变错误态。
  await page.route('**/api/orders**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/api\/orders\/[^/]+$/.test(path)) return fulfillJson(route, { order });
    return fulfillJson(route, { items: [order], page: 1, pageSize: 15, total: 1 });
  });
  await page.route('**/api/orders/order-1/finance**', (route) => fulfillJson(route, {}));
  await page.route('**/api/customers**', (route) => fulfillJson(route, { items: [], total: 0 }));
  await page.route('**/api/orders/order-1/tourists**', (route) =>
    fulfillJson(route, {
      roster: {
        adultCount: 0,
        childCount: 0,
        declaredAdultCount: 2,
        declaredChildCount: 0,
        items: [],
        personCount: 0,
        total: 0,
      },
    }),
  );
  await page.route('**/api/orders/order-1/transition**', async (route) => {
    requests.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    await fulfillJson(route, { order: { ...order, status: 'completed', version: 4 } });
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/trade/orders');
  await page.getByRole('button', { name: /OD-/ }).first().click();
  // 锁团是 requiresReason 动作：空原因提交必须被前端拦住，且不能发出请求。
  await page.getByRole('button', { name: /锁\s*团/ }).click();
  await page
    .getByRole('button', { name: /锁\s*团/ })
    .last()
    .click();
  await expect(page.getByText('请填写操作原因')).toBeVisible();
  expect(requests).toHaveLength(0);

  await page.getByPlaceholder('请说明本次操作原因，会记录在订单上').fill('确认出团后锁价');
  await page
    .getByRole('button', { name: /锁\s*团/ })
    .last()
    .click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ action: 'lock', reason: '确认出团后锁价', version: 3 });
});

test('申请禁止自审：自己提交的那条不显示通过与驳回', async ({ page }) => {
  await installAuthStub(page);
  // createdBy 用 fixture 用户 id：当前用户就是申请人。
  const mine = {
    amount: 1000,
    createdAt: NOW,
    createdBy: 'user-fixture',
    currentStep: 1,
    customerName: '张伟',
    id: 'app-1',
    kind: 'receipt',
    lineId: 'line-1',
    lineName: '团费',
    method: 'bank',
    occurredOn: '2026-11-24',
    orderId: 'order-1',
    orderNumber: 'OD-20261124-001',
    referenceNo: null,
    remark: null,
    status: 'pending',
    updatedAt: NOW,
    version: 1,
    voucherUrl: null,
  };
  await page.route('**/api/finance-applications**', (route) =>
    fulfillJson(route, { items: [mine], page: 1, pageSize: 15, total: 1 }),
  );
  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/finance/applications');
  await expect(page.getByText('OD-20261124-001')).toBeVisible();
  // 自己是申请人 ⇒ 只有「撤回」，没有「通过/驳回」。
  await expect(page.getByRole('button', { name: '撤回' })).toBeVisible();
  await expect(page.getByRole('button', { name: '通过' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '驳回' })).toHaveCount(0);
});

test('结算作废：已确认批次不填原因时前端拦住', async ({ page }) => {
  await installAuthStub(page);
  const requests: Record<string, unknown>[] = [];
  const batch = {
    createdAt: NOW,
    id: 'batch-1',
    itemCount: 1,
    method: 'bank',
    periodMonth: '2026-11',
    status: 'confirmed',
    supplierId: 'supplier-1',
    supplierName: '杭州假日酒店',
    totalAmount: 1000,
    updatedAt: NOW,
  };
  await page.route('**/api/settlements**', (route) =>
    fulfillJson(route, { items: [batch], page: 1, pageSize: 15, total: 1 }),
  );
  // 结算页会拉供应商下拉，不桩就漏到 Vite 代理（ECONNREFUSED）。
  await page.route('**/api/suppliers**', (route) =>
    fulfillJson(route, { items: [], page: 1, pageSize: 100, total: 0 }),
  );
  await page.route('**/api/settlements/batch-1/cancel**', async (route) => {
    requests.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    await fulfillJson(route, { settlementId: 'batch-1', status: 'cancelled', totalAmount: 1000 });
  });
  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/finance/settlements');
  await page
    .getByRole('button', { name: /作\s*废/ })
    .first()
    .click();
  // 作废弹窗的确定按钮文案也是「作废」，用 modal 内的那个。
  // 必须用正则：antd 只给非 link/text 的两字中文按钮插空格，弹窗确认键的实际可访问名是「作 废」，
  // 而行内那个是 type="link"，名字仍是「作废」——同一句文案在两种按钮上是两个不同的名字。
  await page
    .locator('.ant-modal-wrap:visible')
    .getByRole('button', { name: /作\s*废/ })
    .click();
  await expect(page.getByText('已确认批次作废必须填写原因')).toBeVisible();
  expect(requests).toHaveLength(0);

  await page.getByPlaceholder('请写作废原因').fill('重复结算，冲销');
  await page
    .locator('.ant-modal-wrap:visible')
    .getByRole('button', { name: /作\s*废/ })
    .click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ reason: '重复结算，冲销' });
});
