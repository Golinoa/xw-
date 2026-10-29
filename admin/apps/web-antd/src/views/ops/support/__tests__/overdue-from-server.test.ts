import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');

/**
 * 逾期口径（源码参考门 §4.2 硬禁令）：
 * 必须读服务端字段 `isOverdue`，**不得**用 `Date.now()` 与 `dueAt` 比较。
 *
 * 这里用两个角度固定口径：
 * 1. 行为固定：服务端返回 `isOverdue=false` 但 `dueAt` 早已过期 → 页面仍显示「未逾期」；
 * 2. 源码扫描：support 域的展示/页面文件里不存在任何拿当前时间做比较的写法
 *    （防止有人「顺手」加回本地推断）。
 */
const SUPPORT_SOURCES = [
  '../../../api/ops/support/format.ts',
  '../../../api/ops/support/rules.ts',
  '../../../api/ops/support/errors.ts',
  '../../../api/ops/support/tickets.ts',
  'list.vue',
  'detail.vue',
  'timeline.ts',
  'components/ticket-overdue-badge.vue',
];

/** 定位 support 域源码（cwd 可能是 admin 根，也可能是 apps/web-antd）。 */
function readSupportSource(relative: string): string {
  const roots = [
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '..', '..'),
  ];
  for (const root of roots) {
    for (const base of [
      resolve(root, 'src/views/ops/support'),
      resolve(root, 'apps/web-antd/src/views/ops/support'),
    ]) {
      const candidate = resolve(base, relative);
      if (existsSync(candidate)) {
        return readFileSync(candidate, 'utf8');
      }
    }
  }
  throw new Error(
    `找不到 support 域源文件：${relative}（cwd=${process.cwd()}）`,
  );
}

async function mountBadge(ticket: { dueAt?: string; isOverdue?: boolean }) {
  const { mount } = await import('@vue/test-utils');
  const { default: TicketOverdueBadge } =
    await import('../components/ticket-overdue-badge.vue');
  return mount(TicketOverdueBadge, { props: { ticket } });
}

describe('逾期标识只来自服务端字段', () => {
  it('服务端返回 isOverdue=false 时，即使 dueAt 早已过期也显示「未逾期」', async () => {
    const wrapper = await mountBadge({
      dueAt: '2020-01-01T00:00:00Z',
      isOverdue: false,
    });

    expect(wrapper.text()).toContain('未逾期');
    expect(wrapper.text()).not.toContain('已逾期');
    expect(wrapper.find('[data-testid="ticket-overdue-badge"]').exists()).toBe(
      false,
    );
  }, 20_000);

  it('服务端返回 isOverdue=true 时显示「已逾期」，与 dueAt 是否过期无关', async () => {
    const wrapper = await mountBadge({
      dueAt: '2099-12-31T00:00:00Z',
      isOverdue: true,
    });

    expect(wrapper.text()).toContain('已逾期');
    expect(wrapper.find('[data-testid="ticket-overdue-badge"]').exists()).toBe(
      true,
    );
  }, 20_000);

  it('服务端没下发该字段时降级为「逾期标识未返回」，不猜结果', async () => {
    const wrapper = await mountBadge({ dueAt: '2020-01-01T00:00:00Z' });

    expect(wrapper.text()).toContain('逾期标识未返回');
    expect(wrapper.text()).not.toContain('已逾期');
    expect(wrapper.text()).not.toContain('未逾期');
  }, 20_000);

  it('support 域前端代码里没有拿当前时间做比较的写法', () => {
    for (const relative of SUPPORT_SOURCES) {
      const source = readSupportSource(relative);
      expect(source, `${relative} 不得使用 Date.now()`).not.toMatch(
        /Date\.now\(/,
      );
      expect(source, `${relative} 不得使用 performance.now()`).not.toMatch(
        /performance\.now\(/,
      );
      expect(source, `${relative} 不得自行构造当前时间`).not.toMatch(
        /new Date\(\)/,
      );
      expect(source, `${relative} 不得比较 dueAt`).not.toMatch(
        /dueAt\s*[<>]=?/,
      );
    }
  }, 20_000);

  it('展示层确实读的是 isOverdue 字段', () => {
    const source = readSupportSource('../../../api/ops/support/format.ts');
    expect(source).toContain('isOverdue');
  }, 20_000);
});
