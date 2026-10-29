import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

/**
 * 权限拒绝分支（**硬性验收**）：无 `deployment.read` 时不得展示任何实例数据。
 *
 * 断言两件事：
 * 1. 页面只渲染「无权限」说明，不渲染表格/实例名称/版本/维护期；
 * 2. `load()` 在无权限时**直接返回**，连请求都不发（不做「先查后藏」）。
 */
const mocks = vi.hoisted(() => ({
  fetchDeployment: vi.fn(),
  fetchDeployments: vi.fn(),
  granted: new Set<string>(),
  push: vi.fn(),
  back: vi.fn(),
  transitionDeployment: vi.fn(),
  createVersionRecord: vi.fn(),
  updateDeployment: vi.fn(),
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

const INSTANCE = {
  contractId: null,
  currentVersion: 'v1.2.3',
  customer: { id: 'cus-1', name: '示例旅行社甲（虚构）' },
  deploymentType: 'private' as const,
  environmentRef: '环境标识·华东A（虚构）',
  goLiveOn: '2025-03-18',
  id: 'dep-0001',
  instanceNo: 'DP-2026-000601',
  lastVersionRecordAt: '2026-09-12T03:20:00Z',
  maintenanceUntil: '2026-11-15',
  name: '示例旅行社甲·私有化实例A（虚构）',
  owner: { displayName: '交付运营·林（虚构）', id: 'op-4' },
  status: 'active' as const,
  version: 4,
};

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.granted = new Set<string>();
  mocks.fetchDeployments.mockReset();
  mocks.fetchDeployment.mockReset();
  mocks.fetchDeployments.mockResolvedValue({
    items: [INSTANCE],
    page: 1,
    pageSize: 15,
    total: 1,
  });
  mocks.fetchDeployment.mockResolvedValue({
    deployment: INSTANCE,
    licenses: [],
    tickets: [],
    versionRecords: [],
  });
});

describe('权限拒绝时的渲染分支', () => {
  it('实例列表：无 deployment.read 只显示无权限说明，且不发请求', async () => {
    const { mount, flushPromises } = await import('@vue/test-utils');
    const { default: Instances } = await import('../instances.vue');

    const wrapper = mount(Instances, { attachTo: document.body });
    await flushPromises();

    const denied = wrapper.find('[data-testid="deployment-permission-denied"]');
    expect(denied.exists()).toBe(true);
    expect(denied.text()).toContain('deployment.read');

    // 不得渲染任何实例数据
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('示例旅行社甲');
    expect(wrapper.text()).not.toContain('DP-2026-000601');
    expect(wrapper.text()).not.toContain('v1.2.3');

    // 无权限时不请求（不存在「先查再藏」）
    expect(mocks.fetchDeployments).not.toHaveBeenCalled();

    wrapper.unmount();
  }, 30_000);

  it('实例详情：无 deployment.read 只显示无权限说明，且不发请求', async () => {
    const { mount, flushPromises } = await import('@vue/test-utils');
    const { default: Detail } = await import('../detail.vue');

    const wrapper = mount(Detail, { attachTo: document.body });
    await flushPromises();

    const denied = wrapper.find(
      '[data-testid="deployment-detail-permission-denied"]',
    );
    expect(denied.exists()).toBe(true);
    expect(wrapper.text()).not.toContain('示例旅行社甲');
    expect(wrapper.text()).not.toContain('维护期');
    expect(mocks.fetchDeployment).not.toHaveBeenCalled();

    wrapper.unmount();
  }, 30_000);

  it('有 deployment.read 时正常拉取并渲染（证明门禁不是静态隐藏）', async () => {
    mocks.granted = new Set(['deployment.read']);
    const { mount, flushPromises } = await import('@vue/test-utils');
    const { default: Instances } = await import('../instances.vue');

    const wrapper = mount(Instances, { attachTo: document.body });
    await flushPromises();

    expect(mocks.fetchDeployments).toHaveBeenCalledTimes(1);
    expect(
      wrapper.find('[data-testid="deployment-permission-denied"]').exists(),
    ).toBe(false);
    expect(wrapper.text()).toContain('DP-2026-000601');
    // 维护期高亮来自服务端日期（2026-10-29）而非本机时钟
    expect(wrapper.text()).toContain('维护期将到期');

    wrapper.unmount();
  }, 30_000);
});
