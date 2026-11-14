import type { ReceiptDetail } from '#/api/ops/billing/types';

import { useAccessStore, useUserStore } from '@vben/stores';

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OPS_PERMISSION } from '#/constants/permissions';

const RECORDER = '00000000-0000-4000-8000-000000000003';
const REVIEWER = '00000000-0000-4000-8000-000000000002';

const detail: ReceiptDetail = {
  allocations: [],
  receipt: {
    allocatedAmount: 0,
    amount: 86_000,
    approvedAt: null,
    approvedBy: null,
    contractId: null,
    contractNo: null,
    currency: 'CNY',
    customer: { id: 'c-2', name: '云栖数据服务有限公司（虚构）' },
    id: 'p-1',
    method: { code: 'cash', name: '现金' },
    receiptNo: 'RC-2026-000303',
    recordedBy: { displayName: '收款登记·王（虚构）', id: RECORDER },
    recordedReason: null,
    referenceNo: 'CASH-DEMO-0001',
    status: 'recorded',
    transactionDate: '2026-10-20',
    version: 1,
    voucherRef: null,
  },
  refunds: [],
  reversals: [],
};

vi.mock('#/api/ops/billing/receipts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchReceipt: vi.fn(async () => detail),
  };
});

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

function bootStores(operatorId: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAccessStore().setAccessCodes([
    OPS_PERMISSION.RECEIVABLE_READ,
    OPS_PERMISSION.RECEIPT_APPROVE,
    OPS_PERMISSION.RECEIPT_RECONCILE,
    OPS_PERMISSION.RECEIPT_REVERSE,
    OPS_PERMISSION.RECEIPT_REFUND,
  ]);
  useUserStore().setUserInfo({
    avatar: '',
    realName: '测试运营（虚构）',
    roles: ['ops_demo'],
    userId: operatorId,
    username: 'stub@example.invalid',
  });
  return pinia;
}

async function mountDrawer(operatorId: string) {
  const { mount } = await import('@vue/test-utils');
  const { default: ReceiptDetailDrawer } =
    await import('../components/receipt-detail-drawer.vue');
  const pinia = bootStores(operatorId);
  const wrapper = mount(ReceiptDetailDrawer, {
    attachTo: document.body,
    global: { plugins: [pinia] },
    props: { open: true, receiptId: 'p-1' },
  });
  await vi.waitFor(() => {
    expect(
      document.body.querySelector('[data-testid="receipt-approve"]'),
    ).not.toBeNull();
  });
  return wrapper;
}

/**
 * 审核按钮的可用性必须与 `canReviewReceipt` 一致：
 * 当前登录人就是登记人时禁用，并给出可读原因。
 */
describe('收款详情：审核按钮（登记人 ≠ 审核人）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('当前登录人是登记人时，审核按钮不可用且说明原因', async () => {
    const wrapper = await mountDrawer(RECORDER);
    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="receipt-approve"]',
    );

    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(
      document.body.querySelector('[data-testid="receipt-sod-note"]')
        ?.textContent,
    ).toContain('登记人');
    wrapper.unmount();
  }, 20_000);

  it('换成其他运营人员时，审核按钮可用', async () => {
    const wrapper = await mountDrawer(REVIEWER);
    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="receipt-approve"]',
    );

    expect(button?.disabled).toBe(false);
    expect(
      document.body.querySelector('[data-testid="receipt-sod-note"]'),
    ).toBeNull();
    wrapper.unmount();
  }, 20_000);
});
