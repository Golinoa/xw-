import { describe, expect, it, vi } from 'vitest';

import {
  resolveTicketActions,
  ticketReopenAction,
  ticketStatusActions,
} from '#/api/ops/support/rules';
import { OPS_PERMISSION } from '#/constants/permissions';

// 组件经由域出口引入请求客户端，必须显式提供同源基地址（契约环境门禁不允许默认值）。
vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');

/**
 * 状态动作表：只渲染当前状态允许的动作（契约 §3.8）。
 *
 * 「终态无可用动作」的落地口径：`closed` 的**常规处置**动作为空数组；
 * 契约 §3.8 同时允许 `resolved`/`closed` 重开，重开作为「终态例外」单独返回
 * （`ticketReopenAction`），页面上也是独立区块——避免「已关闭工单还有一排按钮」的误读。
 */
function actionNames(status: string): string[] {
  return ticketStatusActions(status).map((action) => action.action);
}

async function mountPanel(
  status: string,
  grantedCodes: string[],
  serverAllowedActions: null | string[] = null,
) {
  const { mount } = await import('@vue/test-utils');
  const { default: TicketStatePanel } =
    await import('../components/ticket-state-panel.vue');
  return mount(TicketStatePanel, {
    props: { grantedCodes, serverAllowedActions, status },
  });
}

describe('工单状态动作表', () => {
  it('每个状态只给出契约 §3.8 允许的动作', () => {
    expect(actionNames('new')).toEqual(['assign']);
    expect(actionNames('assigned')).toEqual(['start']);
    expect(actionNames('in_progress')).toEqual(['wait', 'resolve']);
    expect(actionNames('waiting')).toEqual(['resume', 'resolve']);
    expect(actionNames('resolved')).toEqual(['close']);
  }, 20_000);

  it('终态 closed：没有常规处置动作，重开只作为例外动作存在', () => {
    expect(actionNames('closed')).toEqual([]);

    const reopen = ticketReopenAction('closed');
    expect(reopen?.action).toBe('reopen');
    expect(reopen?.permission).toBe(OPS_PERMISSION.TICKET_CLOSE);
    expect(reopen?.requiresReason).toBe(true);
    // 已解决也允许重开（契约 §3.8：resolved/closed --reopen--> in_progress）
    expect(ticketReopenAction('resolved')?.action).toBe('reopen');
    expect(ticketReopenAction('in_progress')).toBeNull();
  }, 20_000);

  it('未知状态不猜动作（契约 §2.6 降级要求）', () => {
    expect(actionNames('pending_customer')).toEqual([]);
    expect(ticketReopenAction('pending_customer')).toBeNull();
  }, 20_000);

  it('服务端 allowedActions 与本地状态机取交集，冲突时提示刷新', () => {
    // 服务端说只允许 start：本地 in_progress 的 wait/resolve 被挡住
    const blocked = resolveTicketActions('in_progress', ['start']);
    expect(blocked.actions).toHaveLength(0);
    expect(blocked.blockedByServer).toEqual(['wait', 'resolve']);
    expect(blocked.unknownServerActions).toEqual(['start']);

    // 未提供 allowedActions 时按本地状态机渲染
    expect(
      resolveTicketActions('assigned', null).actions.map((a) => a.action),
    ).toEqual(['start']);
  }, 20_000);

  it('面板：处理中只渲染「转入等待 / 标记已解决」，不出现关闭按钮', async () => {
    const wrapper = await mountPanel('in_progress', [
      OPS_PERMISSION.TICKET_READ,
      OPS_PERMISSION.TICKET_UPDATE,
      OPS_PERMISSION.TICKET_CLOSE,
    ]);

    const ids = wrapper
      .findAll('[data-testid^="ticket-action-"]')
      .map((node) => node.attributes('data-testid'));

    expect(ids).toEqual(['ticket-action-wait', 'ticket-action-resolve']);
    expect(wrapper.find('[data-testid="ticket-action-close"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="ticket-action-assign"]').exists()).toBe(
      false,
    );
  }, 20_000);

  it('面板：终态不渲染常规动作，重开在例外区块且缺权限时禁用', async () => {
    const wrapper = await mountPanel('closed', [OPS_PERMISSION.TICKET_READ]);

    expect(
      wrapper.find('[data-testid="ticket-regular-actions"]').exists(),
    ).toBe(false);
    expect(wrapper.text()).toContain('终态');

    const reopen = wrapper.find<HTMLButtonElement>(
      '[data-testid="ticket-action-reopen"]',
    );
    expect(reopen.exists()).toBe(true);
    expect(reopen.element.disabled).toBe(true);
    expect(wrapper.text()).toContain('ticket.close');
  }, 20_000);

  it('面板：缺动作码时按钮禁用并写明缺少哪个码，点击不上报', async () => {
    const wrapper = await mountPanel('assigned', [OPS_PERMISSION.TICKET_READ]);

    const start = wrapper.find<HTMLButtonElement>(
      '[data-testid="ticket-action-start"]',
    );
    expect(start.element.disabled).toBe(true);
    expect(wrapper.text()).toContain('ticket.update');

    await start.trigger('click');
    expect(wrapper.emitted('action')).toBeUndefined();
  }, 20_000);
});
