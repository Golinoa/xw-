import type { EntitlementSnapshotSummary } from '#/api/ops/entitlement/types';

import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

/**
 * 权益快照只读。
 *
 * 两件事必须同时成立：
 * 1. 查询 API 只有 get/list，**没有** update/delete（快照仅 INSERT，契约 §3.5）；
 * 2. 历史面板只有「查看明细」，没有编辑/删除入口，并明确标注不可修改。
 */
const SNAPSHOTS: EntitlementSnapshotSummary[] = [
  {
    contentHash: 'sha256-demo-s2',
    createdAt: '2026-03-05T06:20:00Z',
    createdBy: { displayName: '交付执行·林（虚构）', id: 'op-4' },
    id: 'snap-2',
    lineCount: 4,
    sourceId: 'cr-1',
    sourceType: 'change_request',
    targetScope: 'saas_tenant',
    validFrom: '2026-03-05',
    validTo: '2026-12-31',
  },
  {
    contentHash: 'sha256-demo-s1',
    createdAt: '2025-12-28T02:00:00Z',
    createdBy: { displayName: '交付审批·陈（虚构）', id: 'op-3' },
    id: 'snap-1',
    lineCount: 4,
    sourceId: 'item-1',
    sourceType: 'contract_item',
    targetScope: 'saas_tenant',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
  },
];

describe('快照历史只读', () => {
  it('快照 API 不暴露任何写入函数', async () => {
    const module = await import('#/api/ops/entitlement/snapshots');
    const exported = Object.keys(module);

    expect(exported).toContain('fetchSnapshot');
    expect(exported).toContain('fetchSnapshotHistory');
    expect(
      exported.filter((name) =>
        /update|delete|edit|patch|write|create/i.test(name),
      ),
    ).toEqual([]);
  }, 20_000);

  it('历史面板只有「查看明细」，没有编辑/删除入口', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: SnapshotHistory } =
      await import('../components/snapshot-history.vue');
    const wrapper = mount(SnapshotHistory, {
      props: { currentSnapshotId: 'snap-2', snapshots: SNAPSHOTS },
    });

    const buttonTexts = wrapper.findAll('button').map((node) => node.text());
    expect(buttonTexts).toEqual(['查看明细', '查看明细']);
    expect(buttonTexts.some((text) => /编辑|删除|修改|保存/.test(text))).toBe(
      false,
    );

    expect(wrapper.text()).toContain('仅追加');
    expect(wrapper.text()).toContain('不可修改');
  }, 20_000);

  it('历史按服务端顺序展示，当前快照有标记', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: SnapshotHistory } =
      await import('../components/snapshot-history.vue');
    const wrapper = mount(SnapshotHistory, {
      props: { currentSnapshotId: 'snap-2', snapshots: SNAPSHOTS },
    });

    const rows = wrapper.findAll('tbody tr.ant-table-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain('2026-03-05');
    expect(rows[0]?.text()).toContain('当前');
    expect(wrapper.text()).toContain('变更申请');
    expect(wrapper.text()).toContain('合同条目');
  }, 20_000);

  it('点击「查看明细」只上报快照 id', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: SnapshotHistory } =
      await import('../components/snapshot-history.vue');
    const wrapper = mount(SnapshotHistory, {
      props: { currentSnapshotId: 'snap-2', snapshots: SNAPSHOTS },
    });

    await wrapper.findAll('button')[1]?.trigger('click');
    expect(wrapper.emitted('view')?.[0]).toEqual(['snap-1']);
  }, 20_000);
});
