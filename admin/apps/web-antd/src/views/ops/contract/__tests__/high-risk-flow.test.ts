import type { ContractDetail } from '#/api/ops/contract';

import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createContractRenewal: vi.fn(),
  fetchContract: vi.fn(),
  fetchContractAttachments: vi.fn(),
  fetchContractEntitlementPreview: vi.fn(),
  fetchContractVersions: vi.fn(),
  push: vi.fn(),
  transitionContract: vi.fn(),
}));

vi.mock('#/api/ops/contract', () => ({
  createContractRenewal: mocks.createContractRenewal,
  fetchContract: mocks.fetchContract,
  fetchContractAttachments: mocks.fetchContractAttachments,
  fetchContractEntitlementPreview: mocks.fetchContractEntitlementPreview,
  fetchContractVersions: mocks.fetchContractVersions,
  transitionContract: mocks.transitionContract,
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { contractId: 'con-0001' } }),
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('#/views/ops/_shared/use-ops-permission', () => ({
  useOpsPermission: () => ({
    grantedCodes: { value: new Set<string>() },
    hasAnyPermission: () => true,
    hasPermission: () => true,
  }),
}));

const DETAIL: ContractDetail = {
  allowedActions: ['terminate'],
  attachments: [],
  contract: {
    businessNote: null,
    contractNo: 'HT-2026-000045',
    createdAt: '2026-02-01T01:10:00Z',
    currency: 'CNY',
    currentVersionNo: 1,
    customer: { id: 'cus-0001', name: '示例旅行社甲' },
    effectiveOn: null,
    expiresOn: '2027-02-28',
    id: 'con-0001',
    paymentTerms: null,
    renewedFromContractId: null,
    salesMode: 'saas',
    salesOwner: { displayName: '示例商务甲', id: 'op-demo-001' },
    signedOn: '2026-02-10',
    status: 'signed',
    statusReason: null,
    taxNote: null,
    totalAmount: 396_000,
    updatedAt: '2026-02-10T02:00:00Z',
    version: 3,
  },
  items: [],
  licenses: [],
  receivables: [],
  subscriptions: [],
};

/** 取必须存在的元素，缺失时直接抛错（避免非空断言）。 */
function mustQuery<T extends Element>(selector: string): T {
  const element = document.body.querySelector<T>(selector);
  if (!element) {
    throw new Error(`未找到元素：${selector}`);
  }
  return element;
}

async function mountDetail() {
  const { default: ContractDetailView } = await import('../detail.vue');
  const wrapper = mount(ContractDetailView, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('合同详情 · 高风险动作未确认不发请求', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.fetchContract.mockResolvedValue(DETAIL);
    mocks.fetchContractVersions.mockResolvedValue({ items: [] });
    mocks.fetchContractAttachments.mockResolvedValue({ items: [] });
    mocks.fetchContractEntitlementPreview.mockResolvedValue({
      features: [],
      warnings: [],
    });
    mocks.transitionContract.mockResolvedValue({
      contract: { status: 'terminated', version: 4 },
    });
  });

  it('打开确认弹窗后直接点确认不发请求；填原因并勾选后才调用 transition', async () => {
    const wrapper = await mountDetail();

    const openButton = wrapper
      .findAll('button')
      .find((item) => item.text().replaceAll(/\s+/g, '') === '终止合同');
    if (!openButton) {
      throw new Error('未找到「终止合同」按钮');
    }
    await openButton.trigger('click');
    await nextTick();
    await flushPromises();

    mustQuery<HTMLButtonElement>('[data-testid="hrc-confirm"]').click();
    await nextTick();
    await flushPromises();

    expect(mocks.transitionContract).not.toHaveBeenCalled();

    const reason = mustQuery<HTMLTextAreaElement>('[data-testid="hrc-reason"]');
    reason.value = '客户已完成用印，按合同约定生效';
    reason.dispatchEvent(new Event('input'));
    await nextTick();

    mustQuery<HTMLInputElement>('[data-testid="hrc-ack"]').click();
    await nextTick();
    await flushPromises();

    mustQuery<HTMLButtonElement>('[data-testid="hrc-confirm"]').click();
    await nextTick();
    await flushPromises();

    expect(mocks.transitionContract).toHaveBeenCalledTimes(1);
    expect(mocks.transitionContract).toHaveBeenCalledWith(
      'con-0001',
      expect.objectContaining({
        action: 'terminate',
        confirmImpact: true,
        reason: '客户已完成用印，按合同约定生效',
        version: 3,
      }),
    );
  }, 30_000);
});
