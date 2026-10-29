import type { TenantCommandDetail } from '#/api/ops/tenant/types';

import { useAccessStore } from '@vben/stores';

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OPS_PERMISSION } from '#/constants/permissions';

const state = vi.hoisted(() => ({
  detail: null as null | unknown,
  retryResult: null as null | unknown,
}));

vi.mock('#/api/ops/tenant', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchCommand: vi.fn(async () => state.detail),
    retryCommand: vi.fn(async () => state.retryResult),
  };
});

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

const permanentDetail: TenantCommandDetail = {
  attempts: [
    {
      attemptNo: 1,
      errorCategory: 'permanent',
      finishedAt: '2026-10-26T08:00:03Z',
      httpStatus: 422,
      outcome: 'failed',
      requestId: 'req-attempt-1',
      startedAt: '2026-10-26T07:59:02Z',
    },
  ],
  command: {
    attemptCount: 1,
    commandNo: 'TC-2026-000503',
    commandType: 'revoke',
    completedAt: '2026-10-26T08:00:03Z',
    contractId: null,
    createdAt: '2026-10-26T07:59:00Z',
    id: 'cmd-permanent',
    idempotencyKey: 'demo-cmd-revoke-0003',
    lastErrorCategory: 'permanent',
    lastErrorCode: 'ENTITLEMENT_NOT_FOUND',
    mappingId: 'm-1',
    nextRetryAt: null,
    reason: '客户退订（虚构）',
    requestId: 'req-command-1',
    status: 'failed',
    version: 3,
  },
  retryable: false,
};

const transientDetail: TenantCommandDetail = {
  attempts: [
    {
      attemptNo: 1,
      errorCategory: 'transient',
      finishedAt: '2026-10-28T03:00:10Z',
      httpStatus: 504,
      outcome: 'failed',
      requestId: 'req-attempt-a1',
      startedAt: '2026-10-28T03:00:01Z',
    },
    {
      attemptNo: 2,
      errorCategory: 'unknown',
      finishedAt: null,
      httpStatus: null,
      outcome: 'timeout',
      requestId: 'req-attempt-a2',
      startedAt: '2026-10-28T03:05:00Z',
    },
  ],
  command: {
    attemptCount: 2,
    commandNo: 'TC-2026-000502',
    commandType: 'sync_entitlement',
    completedAt: null,
    contractId: null,
    createdAt: '2026-10-28T03:00:00Z',
    id: 'cmd-transient',
    idempotencyKey: 'demo-cmd-sync-0002',
    lastErrorCategory: 'transient',
    lastErrorCode: 'UPSTREAM_TIMEOUT',
    mappingId: 'm-1',
    nextRetryAt: '2026-10-29T03:10:00Z',
    reason: '同步新增功能键（虚构）',
    requestId: 'req-command-2',
    status: 'failed',
    version: 5,
  },
  retryable: true,
};

function bootStores() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAccessStore().setAccessCodes([
    OPS_PERMISSION.TENANT_READ,
    OPS_PERMISSION.TENANT_RETRY,
    OPS_PERMISSION.ENTITLEMENT_EXECUTE,
  ]);
  return pinia;
}

async function mountDrawer() {
  const { mount } = await import('@vue/test-utils');
  const { default: CommandDetailDrawer } =
    await import('../components/command-detail-drawer.vue');
  const pinia = bootStores();
  const wrapper = mount(CommandDetailDrawer, {
    attachTo: document.body,
    global: { plugins: [pinia] },
    props: { commandId: 'cmd-transient', open: true },
  });
  await vi.waitFor(() => {
    expect(
      document.body.querySelector('[data-testid="tenant-retry-button"]'),
    ).not.toBeNull();
  });
  return wrapper;
}

describe('命令详情抽屉：失败不得装成成功', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('permanent 错误：重试禁用并说明原因，尝试记录完整可读', async () => {
    state.detail = permanentDetail;
    const wrapper = await mountDrawer();

    const retryButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="tenant-retry-button"]',
    );
    expect(retryButton?.disabled).toBe(true);
    expect(
      document.body.querySelector('[data-testid="tenant-permanent-error"]')
        ?.textContent,
    ).toContain('永久性错误不可重试');
    expect(
      document.body.querySelector('[data-testid="tenant-retry-blocked"]')
        ?.textContent,
    ).toContain('重试不会改变结果');

    const attemptsText =
      document.body.querySelector('[data-testid="tenant-command-attempts"]')
        ?.textContent ?? '';
    expect(attemptsText).toContain('422');
    expect(attemptsText).toContain('req-attempt-1');
    expect(attemptsText).toContain('永久性错误');

    wrapper.unmount();
  }, 20_000);

  it('transient 错误：重试可用；重试 202 只显示「已受理」，不显示成功', async () => {
    state.detail = transientDetail;
    state.retryResult = {
      accepted: {
        commandId: 'cmd-transient',
        commandNo: 'TC-2026-000502',
        idempotencyKey: 'demo-cmd-sync-0002',
        replayed: false,
        status: 'retrying',
      },
    };
    const wrapper = await mountDrawer();

    const retryButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="tenant-retry-button"]',
    );
    expect(retryButton?.disabled).toBe(false);
    retryButton?.click();

    await vi.waitFor(() => {
      expect(document.body.querySelector('.ant-modal textarea')).not.toBeNull();
    });
    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      '.ant-modal textarea',
    );
    if (!textarea) {
      throw new Error('未找到重试原因输入框');
    }
    textarea.value = '上游恢复后重试';
    textarea.dispatchEvent(new Event('input'));

    const okButton = document.body.querySelector<HTMLButtonElement>(
      '.ant-modal-footer .ant-btn-primary',
    );
    expect(okButton).not.toBeNull();
    okButton?.click();

    await vi.waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="tenant-accepted-notice"]'),
      ).not.toBeNull();
    });
    const notice =
      document.body.querySelector('[data-testid="tenant-accepted-notice"]')
        ?.textContent ?? '';
    expect(notice).toContain('已受理，结果待确认');
    expect(notice).not.toContain('成功');

    wrapper.unmount();
  }, 20_000);

  it('已发生尝试的命令：取消按钮禁用并说明次数', async () => {
    state.detail = transientDetail;
    const wrapper = await mountDrawer();

    const cancelButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="tenant-cancel-button"]',
    );
    expect(cancelButton?.disabled).toBe(true);
    expect(
      document.body.querySelector('[data-testid="tenant-cancel-blocked"]')
        ?.textContent,
    ).toContain('2 次');

    wrapper.unmount();
  }, 20_000);
});
