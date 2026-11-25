import {
  accountBalanceListResponseSchema,
  adjustBalanceResponseSchema,
  reportResponseSchema,
  supplierReportResponseSchema,
} from '@erp/contracts';
import { expect, test } from '@playwright/test';

import { fulfillJson, installAuthStub, signIn } from './support/session';

const balances = accountBalanceListResponseSchema.parse({
  items: [
    {
      accountId: 'acc-1',
      accountName: '招商银行 6225',
      adjustments: -10,
      balance: 1290.5,
      confirmedIn: 500.5,
      confirmedOut: 200,
      method: 'bank',
      openingBalance: 1000,
    },
  ],
});

const tenantReport = reportResponseSchema.parse({
  byStatus: { active: 5, completed: 2 },
  dateField: 'createdAt',
  finance: { confirmedIn: 6000, confirmedOut: 4000, pendingIn: 1200, pendingOut: 300 },
  from: '2026-11-01',
  includeCancelled: false,
  overview: { orderCount: 7, payableTotal: 9000, profit: 3800.5, receivableTotal: 12_800.5 },
  to: '2026-11-22',
});

const supplierReport = supplierReportResponseSchema.parse({
  items: [
    {
      confirmedAmount: 2500,
      orderCount: 3,
      payableAmount: 4000,
      supplierId: 'sup-1',
      supplierName: '山水国旅',
    },
  ],
});

test('资金账户页展示服务端算好的余额，调整带上账户与原因', async ({ page }) => {
  await installAuthStub(page);

  const adjustBodies: Record<string, unknown>[] = [];

  await page.route('**/api/account-balances**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/adjust')) {
      adjustBodies.push(JSON.parse(route.request().postData() ?? '{}'));
      return fulfillJson(route, adjustBalanceResponseSchema.parse({ adjustmentId: 'adj-1' }));
    }
    return fulfillJson(route, balances);
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/finance/balances');

  await expect(page.getByText('招商银行 6225')).toBeVisible();
  // 余额是服务端字段，页面只做格式化：1000 + 500.5 − 200 − 10。
  await expect(page.getByText('¥1,290.50')).toBeVisible();
  await expect(page.getByText('共 1 个账户')).toBeVisible();

  await page.getByRole('button', { name: '调整' }).click();
  await expect(page.getByText('账户：招商银行 6225')).toBeVisible();

  await page.getByRole('spinbutton').fill('50');
  await page.getByPlaceholder('如：银行手续费').fill('银行手续费');
  await page.getByRole('button', { name: '确认调整' }).click();

  await expect(page.getByText('余额已调整')).toBeVisible();
  expect(adjustBodies).toHaveLength(1);
  expect(adjustBodies[0]).toEqual({
    accountId: 'acc-1',
    amount: 50,
    reason: '银行手续费',
  });
});

/**
 * 报表页有一条**必须由后端配合**的断言：`includeCancelled` 是查询串里的字符串。
 *
 * 后端曾经用 `z.coerce.boolean()`，`'false'` 会被强制成 `true`，于是「取消勾选已取消」
 * 依然把已取消订单算进报表。前端侧能守住的只有「发出去的到底是 false 还是 true」，
 * 解析那一半在 `udone` 的 `reportQuerySchema`（已改 + 有用例）。
 */
test('报表按区间取数，含已取消的开关发出正确的查询值', async ({ page }) => {
  await installAuthStub(page);

  const queries: { includeCancelled: null | string; path: string }[] = [];

  await page.route('**/api/reports/**', async (route) => {
    const url = new URL(route.request().url());
    queries.push({
      includeCancelled: url.searchParams.get('includeCancelled'),
      path: url.pathname,
    });
    return fulfillJson(route, url.pathname.endsWith('/tenant') ? tenantReport : supplierReport);
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/operations/reports');

  await expect(page.getByText('¥12,800.50')).toBeVisible();
  await expect(page.getByText('¥3,800.50')).toBeVisible();
  await expect(page.getByText('山水国旅')).toBeVisible();

  // 首次加载：不含已取消，且区间是本月 1 日到今天。
  expect(queries.length).toBeGreaterThanOrEqual(2);
  expect(queries[0]?.includeCancelled).toBe('false');
  expect(queries.some((item) => item.path.endsWith('/tenant'))).toBe(true);

  await page.getByText('含已取消').click();
  await expect
    .poll(() => queries.at(-1)?.includeCancelled, { timeout: 10_000 })
    .toBe('true');
});
