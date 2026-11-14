import type { TenantMappingDetail } from '#/api/ops/tenant/types';

import { useAccessStore } from '@vben/stores';

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';
import { OPS_PERMISSION } from '#/constants/permissions';

const state = vi.hoisted(() => ({
  createCommand: null as null | unknown,
  detail: null as null | unknown,
}));

vi.mock('#/api/ops/tenant', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createCommand: vi.fn(async () => {
      if (state.createCommand instanceof Error) {
        throw state.createCommand;
      }
      return state.createCommand;
    }),
    fetchMapping: vi.fn(async () => state.detail),
  };
});

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

const detail: TenantMappingDetail = {
  commands: [],
  mapping: {
    customer: {
      customerNo: 'KH-2026-000101',
      id: '11111111-1111-4111-8111-111111111101',
      name: '示例旅行社甲（虚构）',
    },
    externalRef: 'example-jia-prod',
    id: 'm-1',
    lastKnownState: 'active',
    lastSyncedAt: '2026-10-27T09:12:00Z',
    mappingNo: 'TM-2026-000401',
    mappingStatus: 'active',
    productId: 'prod-tour-saas-01',
    syncVersion: 7,
    udoneOrganizationId: '0f0e0d0c-0b0a-4a4b-8c8d-0e0f1a2b3c01',
    version: 4,
  },
};

function syncVersionConflict(): OpsApiError {
  return new OpsApiError({
    code: 'STATE_CONFLICT',
    details: { reason: 'SYNC_VERSION_CONFLICT' },
    kind: 'http',
    reason: 'SYNC_VERSION_CONFLICT',
    requestId: 'req-conflict-1',
    retryable: false,
    status: 409,
    userMessage: 'x',
  });
}

async function mountDrawer() {
  const { mount } = await import('@vue/test-utils');
  const { default: MappingDetailDrawer } =
    await import('../components/mapping-detail-drawer.vue');
  const pinia = createPinia();
  setActivePinia(pinia);
  useAccessStore().setAccessCodes([
    OPS_PERMISSION.TENANT_READ,
    OPS_PERMISSION.TENANT_SUSPEND,
    OPS_PERMISSION.TENANT_PROVISION,
  ]);
  const wrapper = mount(MappingDetailDrawer, {
    attachTo: document.body,
    global: { plugins: [pinia] },
    props: { mappingId: 'm-1', open: true },
  });
  await vi.waitFor(() => {
    expect(
      document.body.querySelector('[data-testid="tenant-command-suspend"]'),
    ).not.toBeNull();
  });
  return wrapper;
}

describe('映射详情：下发命令的版本与冲突处理', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    state.detail = detail;
    state.createCommand = {
      commandId: 'cmd-1',
      commandNo: 'TC-2026-000901',
      idempotencyKey: 'key-1',
      replayed: false,
      status: 'pending',
    };
  });

  it('版本冲突：提示数据已变化、重新拉取映射详情，并关闭表单（不拿旧版本重试）', async () => {
    state.createCommand = syncVersionConflict();
    const { fetchMapping } = await import('#/api/ops/tenant');
    const { createCommand } = await import('#/api/ops/tenant');
    const wrapper = await mountDrawer();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="tenant-command-suspend"]',
      )
      ?.click();

    await vi.waitFor(() => {
      expect(document.body.querySelector('.ant-modal textarea')).not.toBeNull();
    });
    const checkbox = document.body.querySelector<HTMLInputElement>(
      '.ant-modal input[type="checkbox"]',
    );
    if (!checkbox) {
      throw new Error('未找到高风险确认勾选框');
    }
    checkbox.click();

    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      '.ant-modal textarea',
    );
    if (!textarea) {
      throw new Error('未找到原因输入框');
    }
    textarea.value = '客户逾期暂停服务';
    textarea.dispatchEvent(new Event('input'));

    document.body
      .querySelector<HTMLButtonElement>('.ant-modal-footer .ant-btn-primary')
      ?.click();

    await vi.waitFor(() => {
      expect(
        document.body.querySelector(
          '[data-testid="tenant-mapping-refresh-notice"]',
        ),
      ).not.toBeNull();
    });

    const notice =
      document.body.querySelector(
        '[data-testid="tenant-mapping-refresh-notice"]',
      )?.textContent ?? '';
    expect(notice).toContain('数据已变化');
    // 冲突后必须重新拉取映射详情（首次加载 + 冲突后各一次）
    expect(fetchMapping).toHaveBeenCalledTimes(2);
    // 提交的期望版本来自映射详情，不是 0 也不是本地自增
    const createCommandMock = vi.mocked(createCommand);
    expect(createCommandMock.mock.calls[0]?.[1]).toMatchObject({
      expectedSyncVersion: 7,
    });

    wrapper.unmount();
  }, 30_000);
});
