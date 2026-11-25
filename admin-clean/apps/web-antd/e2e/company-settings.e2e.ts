import { approvalFlowSchema, companySettingsSchema } from '@erp/contracts';
import { expect, test } from '@playwright/test';

import { fulfillJson, installAuthStub, signIn } from './support/session';

const settings = companySettingsSchema.parse({
  data: {
    approvalRules: { minApprovalSteps: 2, selfApproval: false },
    companyName: 'Alpha Travel',
    contactPhone: '021-12345678',
    orderRules: { defaultOrderType: 'active', requireDeposit: false },
  },
  // 契约要求这两个字段是 UUID；组织 id 与夹具成员里的 'org-alpha' 不同不影响本用例，
  // 页面只把配置当数据展示，组织上下文来自 `/api/me`。
  organizationId: 'a0000000-0000-4000-8000-000000000001',
  updatedAt: '2026-11-22T02:00:00.000Z',
  updatedBy: 'a1000000-0000-4000-8000-000000000001',
  version: 3,
});

const flow = approvalFlowSchema.parse({
  allowSelfApproval: false,
  allowWithdraw: true,
  steps: [{ permission: 'finance.approve', step: 1 }],
});

/**
 * 二次确认是这张页面最容易做坏的一条链路：
 *
 * 服务端改审批/订单规则时返回 400 + `details.field='confirmed'`，前端必须弹确认框，
 * 用户点「确认保存」后再发一次带 `confirmed: true` 的请求。
 * 旧前端的判断是 `message.includes('confirmation')`——而 `api-client` 已经把
 * `message` 换成了错误码对应的中文文案，那条件永远为假，于是「改审批规则」怎么都存不进去，
 * 用户只会看到「提交的内容不合法」。这条用例就是钉住这个行为。
 */
test('改订单规则要求二次确认，确认后才真正保存', async ({ page }) => {
  await installAuthStub(page);

  const savedBodies: Record<string, unknown>[] = [];

  await page.route('**/api/approvals/flow**', async (route) => {
    if (route.request().method() === 'GET') {
      return fulfillJson(route, flow);
    }
    return fulfillJson(route, JSON.parse(route.request().postData() ?? '{}'));
  });

  await page.route('**/api/company-settings**', async (route) => {
    if (route.request().method() === 'GET') {
      return fulfillJson(route, settings);
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    savedBodies.push(body);
    if (body.confirmed !== true) {
      return fulfillJson(
        route,
        {
          code: 'VALIDATION_ERROR',
          details: { field: 'confirmed', key: 'orderRules' },
          message: 'Changing financial or permission settings requires confirmation',
          requestId: 'req-fixture-1',
        },
        400,
      );
    }
    return fulfillJson(route, {
      ...settings,
      data: body.data,
      version: 4,
    });
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/config/company');

  await expect(page.getByText('当前版本 3', { exact: false })).toBeVisible();
  await expect(page.getByLabel('公司名称')).toHaveValue('Alpha Travel');

  // 勾上「下单必须收定金」，这是服务端认定的敏感改动。
  await page.getByText('下单必须收定金').click();
  await page.getByRole('button', { name: '保存配置' }).click();

  await expect(page.getByText('本次修改包含 审批规则 / 订单规则')).toBeVisible();
  await page.getByRole('button', { name: '确认保存' }).click();

  await expect(page.getByText('公司配置已保存')).toBeVisible();

  expect(savedBodies).toHaveLength(2);
  expect(savedBodies[0]?.confirmed).toBe(false);
  expect(savedBodies[1]?.confirmed).toBe(true);
  const confirmedSave = savedBodies[1];
  if (!confirmedSave) throw new Error('没有记录到二次确认后的保存请求');
  expect(confirmedSave.expectedVersion).toBe(3);
  const confirmedData = confirmedSave.data as { orderRules: { requireDeposit: boolean } };
  expect(confirmedData.orderRules.requireDeposit).toBe(true);
});

/** 业务操作员的角色矩阵里没有 `settings.manage`：页面只读，两个保存按钮都不该出现。 */
test('业务操作员看得到配置但改不了', async ({ page }) => {
  await installAuthStub(page, {
    memberships: [
      { organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'operator' },
    ],
  });

  await page.route('**/api/approvals/flow**', (route) => fulfillJson(route, flow));
  await page.route('**/api/company-settings**', (route) => fulfillJson(route, settings));

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/config/company');

  await expect(page.getByLabel('公司名称')).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存配置' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存审批流' })).toHaveCount(0);
});
