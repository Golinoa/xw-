import { useAccessStore, useUserStore } from '@vben/stores';

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canAssignTicket,
  canCommentTicket,
  canViewTicket,
} from '#/api/ops/support/rules';
import { OPS_PERMISSION } from '#/constants/permissions';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');

/**
 * 权限拒绝分支：
 * 1. `canViewTicket()` 无 `ticket.read` 时拒绝，并说明缺哪个动作码；
 * 2. 页面在无 `ticket.read` 时**不渲染任何工单内容**（尤其客户联系方式），
 *    只显示「无访问权限 + 所需动作码」；
 * 3. 有 `ticket.read` 但没有 `ticket.create` 时，建单入口不渲染。
 *
 * 页面用开发态桩（`VITE_OPS_MOCK=true`）供数，避免测试依赖真实后端；
 * 桩数据本身在 `fixtures.ts` 里全部为虚构客户。
 */
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('#/api/ops/customer', () => ({
  OPS_DEFAULT_PAGE_SIZE: 15,
  fetchCustomers: vi.fn(async () => ({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
  })),
}));

vi.stubEnv('VITE_OPS_MOCK', 'true');

function bootStores(accessCodes: string[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAccessStore().setAccessCodes(accessCodes);
  useUserStore().setUserInfo({
    avatar: '',
    realName: '测试运营（虚构）',
    roles: ['ops_demo'],
    userId: '00000000-0000-4000-8000-000000000011',
    username: 'stub@example.invalid',
  });
  return pinia;
}

async function mountList(accessCodes: string[]) {
  const { mount } = await import('@vue/test-utils');
  const { default: SupportTicketList } = await import('../list.vue');
  const pinia = bootStores(accessCodes);
  const wrapper = mount(SupportTicketList, {
    attachTo: document.body,
    global: { plugins: [pinia] },
  });
  await vi.waitFor(() => {
    expect(document.body.textContent).not.toBe('');
  });
  return wrapper;
}

describe('工单域权限拒绝', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('无 ticket.read：拒绝查看并给出动作码', () => {
    const decision = canViewTicket({ hasReadPermission: false });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('permission');
    expect(decision.message).toContain('ticket.read');
    expect(canViewTicket({ hasReadPermission: true }).allowed).toBe(true);
  }, 20_000);

  it('无 ticket.read 的页面不展示任何工单内容（含客户联系方式）', async () => {
    // 给一个与工单无关的动作码：用于验证「有权限但不是工单权限」也照样拒绝
    const wrapper = await mountList([OPS_PERMISSION.RECEIVABLE_READ]);

    const text = document.body.textContent ?? '';
    expect(text).toContain('无访问权限');
    expect(text).toContain('ticket.read');
    expect(text).not.toContain('TK-2026');
    expect(text).not.toContain('示例旅行社甲');
    expect(text).not.toContain('138****0001');
    wrapper.unmount();
  }, 20_000);

  it('有 ticket.read 时能看到工单，但没有 ticket.create 不渲染建单入口', async () => {
    const wrapper = await mountList([OPS_PERMISSION.TICKET_READ]);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('TK-2026-000101');
    });
    expect(document.body.textContent).toContain('示例旅行社甲（虚构）');
    expect(document.body.textContent).not.toContain('新建工单');
    wrapper.unmount();
  }, 20_000);

  it('已关闭工单：分派与备注都以「状态」拒绝并说明原因', () => {
    const assign = canAssignTicket({
      hasAssignPermission: true,
      status: 'closed',
    });
    expect(assign.allowed).toBe(false);
    expect(assign.code).toBe('state');
    expect(assign.message).toContain('重开');

    const comment = canCommentTicket({
      hasUpdatePermission: true,
      status: 'closed',
    });
    expect(comment.allowed).toBe(false);
    expect(comment.code).toBe('state');

    expect(
      canCommentTicket({ hasUpdatePermission: true, status: 'in_progress' })
        .allowed,
    ).toBe(true);
  }, 20_000);
});
