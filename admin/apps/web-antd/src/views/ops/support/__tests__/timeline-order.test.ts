import type { TicketEvent } from '#/api/ops/support/types';

import { describe, expect, it, vi } from 'vitest';

import { buildTicketTimeline, summarizeTimeline } from '../timeline';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');

/**
 * 时间线是核心可读物（源码参考门 §4.3）：
 * 按时间**升序**展示，且分派、状态变更、备注三类事件都能读出来。
 *
 * 服务端可能倒序返回，这里故意把事件打乱，验证页面侧统一重排。
 */
const EVENTS: TicketEvent[] = [
  {
    actor: { displayName: '售后支持·赵（虚构）', id: 'op-1' },
    body: '内部说明：已电话联系客户确认时间',
    createdAt: '2026-10-22T03:00:00Z',
    eventType: 'comment',
    id: 'e3',
  },
  {
    actor: { displayName: '售后主管·孙（虚构）', id: 'op-2' },
    body: '按区域分工分派给一线支持',
    createdAt: '2026-10-21T02:00:00Z',
    eventType: 'assigned',
    fromStatus: 'new',
    id: 'e2',
    toStatus: 'assigned',
  },
  {
    actor: { displayName: '售后支持·赵（虚构）', id: 'op-1' },
    createdAt: '2026-10-20T01:00:00Z',
    eventType: 'created',
    id: 'e1',
    toStatus: 'new',
  },
  {
    actor: { displayName: '售后支持·赵（虚构）', id: 'op-1' },
    body: '开始处理：已向客户索取抬头变更说明',
    createdAt: '2026-10-23T01:00:00Z',
    eventType: 'status_changed',
    fromStatus: 'assigned',
    id: 'e4',
    toStatus: 'in_progress',
  },
];

describe('工单时间线', () => {
  it('按时间升序排列（服务端倒序也不会读反）', () => {
    const entries = buildTicketTimeline(EVENTS);

    expect(entries.map((entry) => entry.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(entries.map((entry) => entry.at)).toEqual(
      [...entries.map((entry) => entry.at)].toSorted(),
    );
  }, 20_000);

  it('包含分派、状态变更、备注三类事件，并画出状态变迁路径', () => {
    const entries = buildTicketTimeline(EVENTS);
    const kinds = new Set(entries.map((entry) => entry.kind));

    expect(kinds.has('assignment')).toBe(true);
    expect(kinds.has('status')).toBe(true);
    expect(kinds.has('comment')).toBe(true);

    const assigned = entries.find((entry) => entry.id === 'e2');
    expect(assigned?.change).toBe('待受理 → 已分派');
    expect(assigned?.actor).toContain('售后主管·孙');
    expect(assigned?.reason).toContain('区域分工');
  }, 20_000);

  it('每类事件都有操作者与时间，备注正文不会丢', () => {
    const entries = buildTicketTimeline(EVENTS);

    for (const entry of entries) {
      expect(entry.actor).not.toBe('');
      expect(entry.at).not.toBe('—');
    }
    const comment = entries.find((entry) => entry.id === 'e3');
    expect(comment?.reason).toBe('内部说明：已电话联系客户确认时间');
  }, 20_000);

  it('概览计数与分页/空数据降级', () => {
    const summary = summarizeTimeline(buildTicketTimeline(EVENTS));
    expect(summary).toEqual({
      assignments: 1,
      comments: 1,
      statusChanges: 1,
      total: 4,
    });

    expect(buildTicketTimeline(null)).toEqual([]);
    expect(buildTicketTimeline([])).toEqual([]);
  }, 20_000);

  it('组件渲染顺序与升序一致，且三类事件都在 DOM 里', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: TicketTimeline } =
      await import('../components/ticket-timeline.vue');

    const wrapper = mount(TicketTimeline, {
      props: { entries: buildTicketTimeline(EVENTS) },
    });

    const items = wrapper.findAll('[data-testid="ticket-timeline-item"]');
    expect(items).toHaveLength(4);

    const text = items.map((item) => item.text());
    expect(text[0]).toContain('创建');
    expect(text[1]).toContain('分派');
    expect(text[1]).toContain('待受理 → 已分派');
    expect(text[2]).toContain('备注');
    expect(text[3]).toContain('状态变更');
    expect(text[3]).toContain('已分派 → 处理中');
  }, 20_000);
});
