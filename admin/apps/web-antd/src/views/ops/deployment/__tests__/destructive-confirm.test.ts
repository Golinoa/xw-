import { nextTick } from 'vue';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

/**
 * 破坏性动作的二次确认（PRD §1.3、§4.3；契约 §3.7「retire 需 reason」）。
 *
 * 三条必须成立的规则：
 * 1. 点动作按钮**只打开确认弹窗**，不发请求；
 * 2. 未填原因 / 未勾选确认 → 仍然不发请求；
 * 3. 原因 + 勾选都通过后才发请求，且原因 trim 后随请求提交。
 *
 * 另外覆盖状态动作表：`active` 只能「进入维护 / 退役」，终态没有任何动作；
 * `go_live` 缺上线日期时前端先拦（契约 §3.7 守卫）。
 */
const mocks = vi.hoisted(() => ({
  createVersionRecord: vi.fn(),
  fetchDeployment: vi.fn(),
  fetchDeployments: vi.fn(),
  granted: new Set<string>(['deployment.read', 'deployment.write']),
  transitionDeployment: vi.fn(),
  updateDeployment: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
}));

vi.mock('#/views/ops/_shared/use-ops-permission', async () => {
  const { computed } = await import('vue');
  return {
    useOpsPermission: () => ({
      grantedCodes: computed(() => mocks.granted),
      hasAnyPermission: () => mocks.granted.size > 0,
      hasPermission: (code: string) => mocks.granted.has(code),
    }),
  };
});

vi.mock('#/api/ops/identity', () => ({
  fetchOpsMeta: async () => ({
    contractVersion: '1.0.0',
    serverTime: '2026-10-29T02:00:00Z',
    supportedCurrencies: ['CNY'],
    supportedSalesModes: ['saas', 'private'],
    timezone: 'Asia/Shanghai',
  }),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { deploymentId: 'dep-0001' } }),
  useRouter: () => ({ back: mocks.back, push: mocks.push }),
}));

vi.mock('#/api/ops/deployment', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createVersionRecord: mocks.createVersionRecord,
    fetchDeployment: mocks.fetchDeployment,
    fetchDeployments: mocks.fetchDeployments,
    transitionDeployment: mocks.transitionDeployment,
    updateDeployment: mocks.updateDeployment,
  };
});

const IMPACT =
  '退役为终态：实例不再出现在可用实例中，历史版本记录与工单仍可查。';

function setReason(value: string): void {
  const textarea = document.body.querySelector('textarea');
  if (!textarea) {
    throw new Error('未找到原因输入框');
  }
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleAck(): void {
  const box = document.body.querySelector<HTMLInputElement>(
    '.ant-checkbox-input',
  );
  box?.click();
}

function clickOk(): void {
  const button = document.body.querySelector<HTMLButtonElement>(
    '.ant-modal-footer .ant-btn-primary',
  );
  if (!button) {
    throw new Error('未找到确认按钮');
  }
  button.click();
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.transitionDeployment.mockReset();
  mocks.transitionDeployment.mockResolvedValue({
    deployment: { status: 'retired', version: 5 },
  });
});

describe('破坏性动作确认弹窗', () => {
  it('未填原因点确认不发事件（因此不发请求）', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: Confirm } =
      await import('../components/transition-confirm-modal.vue');
    const wrapper = mount(Confirm, {
      attachTo: document.body,
      props: {
        actionLabel: '退役实例',
        impact: IMPACT,
        open: true,
        requiresReason: true,
        summaryRows: [{ label: '实例编号', value: 'DP-2026-000601' }],
      },
    });

    toggleAck();
    clickOk();
    await nextTick();

    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(document.body.textContent).toContain('请填写操作原因');

    wrapper.unmount();
  }, 30_000);

  it('填了原因但未勾选确认 → 仍然不发事件', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: Confirm } =
      await import('../components/transition-confirm-modal.vue');
    const wrapper = mount(Confirm, {
      attachTo: document.body,
      props: {
        actionLabel: '退役实例',
        impact: IMPACT,
        open: true,
        requiresReason: true,
      },
    });

    setReason('客户已停止使用');
    clickOk();
    await nextTick();

    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(document.body.textContent).toContain('请先确认已阅读影响摘要');

    wrapper.unmount();
  }, 30_000);

  it('原因 + 勾选都通过后才上报，并 trim 原因', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: Confirm } =
      await import('../components/transition-confirm-modal.vue');
    const wrapper = mount(Confirm, {
      attachTo: document.body,
      props: {
        actionLabel: '退役实例',
        impact: IMPACT,
        open: true,
        requiresReason: true,
      },
    });

    setReason('  客户已停止使用  ');
    toggleAck();
    clickOk();
    await nextTick();

    expect(wrapper.emitted('confirm')?.[0]).toEqual(['客户已停止使用']);

    wrapper.unmount();
  }, 30_000);
});

describe('状态动作表与守卫', () => {
  it('active：只能「进入维护 / 退役」，退役标记破坏性且需原因', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: StatePanel } =
      await import('../components/state-panel.vue');
    const wrapper = mount(StatePanel, {
      props: {
        grantedCodes: ['deployment.read', 'deployment.write'],
        status: 'active' as const,
      },
    });

    const keys = wrapper
      .findAll('[data-testid^="deployment-action-"]')
      .map((node) => node.attributes('data-testid'));

    expect(keys).toEqual([
      'deployment-action-start_maintenance',
      'deployment-action-retire',
    ]);
    expect(wrapper.text()).toContain('破坏性');
    expect(wrapper.text()).toContain('需填写原因');

    await wrapper
      .find('[data-testid="deployment-action-retire"]')
      .trigger('click');
    const emitted = wrapper.emitted('action')?.[0]?.[0] as
      | undefined
      | { destructive: boolean; key: string; requiresReason: boolean };
    expect(emitted?.key).toBe('retire');
    expect(emitted?.destructive).toBe(true);
    expect(emitted?.requiresReason).toBe(true);
  }, 20_000);

  it('retired 终态没有任何动作按钮', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: StatePanel } =
      await import('../components/state-panel.vue');
    const wrapper = mount(StatePanel, {
      props: {
        grantedCodes: ['deployment.read', 'deployment.write'],
        status: 'retired' as const,
      },
    });

    expect(wrapper.findAll('[data-testid^="deployment-action-"]')).toHaveLength(
      0,
    );
    expect(wrapper.text()).toContain('终态');
  }, 20_000);

  it('缺 deployment.write 时动作按钮禁用并说明缺少动作码', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: StatePanel } =
      await import('../components/state-panel.vue');
    const wrapper = mount(StatePanel, {
      props: { grantedCodes: ['deployment.read'], status: 'planned' as const },
    });

    const button = wrapper.find<HTMLButtonElement>(
      '[data-testid="deployment-action-go_live"]',
    );
    expect(button.element.disabled).toBe(true);
    expect(wrapper.text()).toContain('当前账号缺少该动作码');
    expect(wrapper.text()).toContain('deployment.write');
  }, 20_000);

  it('go_live 缺上线日期时被前端守卫拦下（契约 §3.7）', async () => {
    const { guardDeploymentAction } = await import('#/api/ops/deployment');

    const denied = guardDeploymentAction('go_live', {
      goLiveOn: null,
      status: 'planned',
    });
    expect(denied.allowed).toBe(false);
    expect(denied.message).toContain('上线日期');

    expect(
      guardDeploymentAction('go_live', {
        goLiveOn: '2026-10-01',
        status: 'planned',
      }).allowed,
    ).toBe(true);

    // 状态不允许的动作同样被拦（活跃实例不能再次 go_live）
    expect(
      guardDeploymentAction('go_live', {
        goLiveOn: '2026-10-01',
        status: 'active',
      }).code,
    ).toBe('state');
  }, 20_000);
});

describe('详情页：未确认不发请求', () => {
  const INSTANCE = {
    contractId: null,
    currentVersion: 'v1.2.3',
    customer: { id: 'cus-1', name: '示例旅行社甲（虚构）' },
    deploymentType: 'private' as const,
    environmentRef: '环境标识·华东A（虚构）',
    goLiveOn: '2025-03-18',
    id: 'dep-0001',
    instanceNo: 'DP-2026-000601',
    maintenanceUntil: '2026-11-15',
    name: '示例旅行社甲·私有化实例A（虚构）',
    owner: { displayName: '交付运营·林（虚构）', id: 'op-4' },
    status: 'active' as const,
    version: 4,
  };

  it('点「退役」只打开确认弹窗；未填写原因不发请求；填完原因+勾选才发一次', async () => {
    mocks.fetchDeployment.mockResolvedValue({
      deployment: INSTANCE,
      licenses: [],
      tickets: [],
      versionRecords: [],
    });
    const { mount, flushPromises } = await import('@vue/test-utils');
    const { default: Detail } = await import('../detail.vue');

    const wrapper = mount(Detail, { attachTo: document.body });
    await flushPromises();

    await wrapper
      .find('[data-testid="deployment-action-retire"]')
      .trigger('click');
    await flushPromises();

    expect(document.body.textContent).toContain('二次确认');
    expect(mocks.transitionDeployment).not.toHaveBeenCalled();

    // 只勾选、不填原因 → 仍然不发请求
    toggleAck();
    clickOk();
    await flushPromises();
    expect(mocks.transitionDeployment).not.toHaveBeenCalled();

    // 填原因 + 勾选 → 发一次，原因 trim 后提交
    setReason('  合同终止，实例退役  ');
    clickOk();
    await flushPromises();

    expect(mocks.transitionDeployment).toHaveBeenCalledTimes(1);
    expect(mocks.transitionDeployment).toHaveBeenCalledWith('dep-0001', {
      action: 'retire',
      reason: '合同终止，实例退役',
      version: 4,
    });

    wrapper.unmount();
  }, 30_000);
});
