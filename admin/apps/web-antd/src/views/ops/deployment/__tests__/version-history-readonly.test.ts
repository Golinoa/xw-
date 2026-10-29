import type { DeploymentVersionRecord } from '#/api/ops/deployment/types';

import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

/**
 * 版本历史只读（契约 §3.7：`ops.deployment_version_records` 仅 INSERT）。
 *
 * 两件事必须同时成立：
 * 1. 查询 API 只有 list/create（追加），**没有** update/delete；
 * 2. 历史面板没有任何编辑/删除入口，并明确标注「仅追加、不可修改」。
 *
 * 附带覆盖升级登记的前置校验：`fromVersion` 必须等于实例当前版本，否则
 * 服务端 409 `STATE_CONFLICT` + `VERSION_MISMATCH`——前端在提交前先拦一次。
 */
const RECORDS: DeploymentVersionRecord[] = [
  {
    createdAt: '2026-09-12T03:20:00Z',
    executedBy: { displayName: '交付运营·林（虚构）', id: 'op-4' },
    executedOn: '2026-09-12',
    fromVersion: 'v1.2.2',
    id: 'rec-2',
    impactNote: '常规补丁升级（虚构）',
    result: 'succeeded',
    rollbackNote: null,
    toVersion: 'v1.2.3',
  },
  {
    createdAt: '2026-08-20T06:10:00Z',
    executedBy: { displayName: '售后支持·赵（虚构）', id: 'op-5' },
    executedOn: '2026-08-20',
    fromVersion: 'v1.2.1',
    id: 'rec-1',
    impactNote: '升级后报表导出报错（虚构）',
    result: 'rolled_back',
    rollbackNote: '已回滚至 v1.2.1',
    toVersion: 'v1.2.2',
  },
];

describe('版本历史只读', () => {
  it('版本记录 API 只有读与追加，不存在更新/删除函数', async () => {
    const module = await import('#/api/ops/deployment/version-records');
    const exported = Object.keys(module);

    expect(exported).toContain('fetchVersionRecords');
    expect(exported).toContain('createVersionRecord');
    expect(
      exported.filter((name) =>
        /update|delete|edit|patch|remove|revert/i.test(name),
      ),
    ).toEqual([]);
  }, 20_000);

  it('历史面板没有编辑/删除按钮，并标注「仅追加」', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: VersionHistory } =
      await import('../components/version-history.vue');
    const wrapper = mount(VersionHistory, { props: { records: RECORDS } });

    // 面板内不应有任何按钮（没有「编辑」「删除」「撤销登记」）
    expect(wrapper.findAll('button')).toHaveLength(0);
    // 表头没有「操作」列，正文不出现编辑入口
    const headerTexts = wrapper.findAll('thead th').map((node) => node.text());
    expect(headerTexts).not.toContain('操作');
    expect(wrapper.text()).not.toContain('编辑');

    const note = wrapper.find(
      '[data-testid="deployment-version-history-note"]',
    );
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain('仅追加');
    expect(note.text()).toContain('不可修改');
  }, 20_000);

  it('历史按服务端顺序展示，前后版本与结果都可读', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: VersionHistory } =
      await import('../components/version-history.vue');
    const wrapper = mount(VersionHistory, { props: { records: RECORDS } });

    const rows = wrapper.findAll('tbody tr.ant-table-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain('v1.2.2 → v1.2.3');
    expect(rows[0]?.text()).toContain('成功');
    expect(rows[1]?.text()).toContain('已回滚');
    expect(rows[1]?.text()).toContain('已回滚至 v1.2.1');
  }, 20_000);
});

describe('升级登记前置校验', () => {
  it('升级前版本必须等于实例当前版本（否则 VERSION_MISMATCH）', async () => {
    const { validateVersionRecordInput } = await import('#/api/ops/deployment');

    const mismatch = validateVersionRecordInput({
      currentVersion: 'v1.2.3',
      executedOn: '2026-10-29',
      fromVersion: 'v1.2.2',
      toVersion: 'v1.2.4',
    });

    expect(mismatch.allowed).toBe(false);
    expect(mismatch.code).toBe('version_mismatch');
    expect(mismatch.message).toContain('v1.2.3');
  }, 20_000);

  it('前后版本相同 / 缺执行日期 / 缺版本 都被拦下', async () => {
    const { validateVersionRecordInput } = await import('#/api/ops/deployment');

    expect(
      validateVersionRecordInput({
        currentVersion: 'v1.2.3',
        executedOn: '2026-10-29',
        fromVersion: 'v1.2.3',
        toVersion: 'v1.2.3',
      }).code,
    ).toBe('state');

    expect(
      validateVersionRecordInput({
        currentVersion: 'v1.2.3',
        executedOn: '',
        fromVersion: 'v1.2.3',
        toVersion: 'v1.2.4',
      }).code,
    ).toBe('validation');

    expect(
      validateVersionRecordInput({
        currentVersion: null,
        executedOn: '2026-10-29',
        fromVersion: 'v1.2.3',
        toVersion: '   ',
      }).code,
    ).toBe('validation');
  }, 20_000);

  it('合法登记通过校验（版本号只做字符串比较，不解析大小）', async () => {
    const { validateVersionRecordInput } = await import('#/api/ops/deployment');

    expect(
      validateVersionRecordInput({
        currentVersion: 'v1.2.3',
        executedOn: '2026-10-29',
        fromVersion: 'v1.2.3',
        toVersion: 'v1.10.0',
      }).allowed,
    ).toBe(true);
  }, 20_000);
});
