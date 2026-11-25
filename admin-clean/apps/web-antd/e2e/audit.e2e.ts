import { auditFacetsResponseSchema, auditListResponseSchema } from '@erp/contracts';
import { expect, test } from '@playwright/test';

import { fulfillJson, installAuthStub, signIn } from './support/session';

const auditList = auditListResponseSchema.parse({
  items: [
    {
      id: 'ae-1',
      actorName: 'staff@example.test',
      action: 'finance_application.approve',
      entityType: 'finance_application',
      entityId: 'app-1',
      summary: '审批通过收款申请 ¥1,200.00',
      ipSummary: '10.0.0.1',
      deviceSummary: 'Chrome / Windows',
      requestId: 'req-1',
      createdAt: '2026-11-22T02:10:00.000Z',
    },
  ],
  page: 1,
  pageSize: 15,
  total: 1,
});

const auditFacets = auditFacetsResponseSchema.parse({
  actions: ['finance_application.approve', 'customer.update'],
  entityTypes: ['finance_application', 'customer'],
});

test('管理员能查看审计日志与筛选项', async ({ page }) => {
  await installAuthStub(page);

  await page.route('**/api/audit-events**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/facets')) {
      return fulfillJson(route, auditFacets);
    }
    return fulfillJson(route, auditList);
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/operations/audit');

  await expect(page.getByText('审批通过收款申请 ¥1,200.00')).toBeVisible();
  await expect(page.getByText('共 1 条')).toBeVisible();
});

/**
 * 权限门禁：`operator` 的角色矩阵里没有 `audit.read`。
 *
 * 断言两件事：页面给出「没有权限」的明示，且**根本不去请求**审计端点——
 * 只把按钮藏起来但照样发请求，等于把数据送到了没有权限的人手里。
 */
test('业务操作员看不到审计数据，也不会发出审计请求', async ({ page }) => {
  await installAuthStub(page, {
    memberships: [{ organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'operator' }],
  });

  let auditRequested = false;
  await page.route('**/api/audit-events**', async (route) => {
    auditRequested = true;
    return fulfillJson(route, auditList);
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/operations/audit');

  await expect(page.getByText('当前账号没有查看审计日志的权限。')).toBeVisible();
  expect(auditRequested).toBe(false);
});
