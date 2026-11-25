import { notificationListResponseSchema } from '@erp/contracts';
import { expect, test } from '@playwright/test';

import { fulfillJson, installAuthStub, signIn } from './support/session';

/**
 * 通知页回归：列表、未读筛选、标记已读。
 *
 * 夹具一律先过契约：字段改了而夹具没跟上时当场红，
 * 不会出现「页面看着正常、其实拿的是旧字段」。
 */
const notifications = notificationListResponseSchema.parse({
  items: [
    {
      id: 'n1',
      type: 'approval_pending',
      title: '有一笔待审批的收款申请',
      body: '客户 A 的收款申请 ¥1,200.00 等待你的审批',
      entityType: 'finance_application',
      entityId: 'app-1',
      read: false,
      createdAt: '2026-11-22T02:00:00.000Z',
    },
    {
      id: 'n2',
      type: 'settlement_confirmed',
      title: '结算批次已确认',
      body: '供应商 B 的结算批次 ST-001 已确认',
      entityType: 'settlement_batch',
      entityId: 'batch-1',
      read: true,
      createdAt: '2026-11-21T09:30:00.000Z',
    },
  ],
  page: 1,
  pageSize: 15,
  total: 2,
});

test('通知列表渲染并按未读筛选，标记已读打到正确的端点', async ({ page }) => {
  await installAuthStub(page);

  const listQueries: URLSearchParams[] = [];
  let markBody: unknown;

  await page.route('**/api/notifications**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.endsWith('/unread-count')) {
      return fulfillJson(route, { count: 1 });
    }
    if (request.method() === 'PATCH') {
      markBody = request.postDataJSON();
      return fulfillJson(route, { updated: 1 });
    }
    listQueries.push(url.searchParams);
    return fulfillJson(route, notifications);
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/operations/notifications');

  await expect(page.getByText('有一笔待审批的收款申请')).toBeVisible();
  await expect(page.getByText('共 2 条')).toBeVisible();
  // 首屏请求不该带 unreadOnly：默认看全部。
  expect(listQueries[0]?.get('unreadOnly') ?? 'false').toBe('false');

  await page.getByText('只看未读').click();
  await expect.poll(() => listQueries.at(-1)?.get('unreadOnly')).toBe('true');

  await page.getByRole('button', { name: 'mark-read' }).first().click();
  await expect.poll(() => markBody).toEqual({ ids: ['n1'] });
});
