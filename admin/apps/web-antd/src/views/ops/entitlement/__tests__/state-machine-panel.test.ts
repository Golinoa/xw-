import { describe, expect, it } from 'vitest';

import { OPS_PERMISSION } from '#/constants/permissions';

/**
 * 状态机面板：**只渲染当前状态允许的动作**。
 *
 * 这是「界面不得直写终态」的呈现侧保证：生效中不会出现「提交审批」，
 * 待审批不会出现「执行」，终态一个按钮也没有。
 */
async function mountPanel(status: string, grantedCodes: string[]) {
  const { mount } = await import('@vue/test-utils');
  const { default: StateMachinePanel } =
    await import('../components/state-machine-panel.vue');
  return mount(StateMachinePanel, {
    props: { grantedCodes, status },
  });
}

describe('状态机面板', () => {
  it('草稿：只渲染「提交审批」，不渲染审批/执行', async () => {
    const wrapper = await mountPanel('draft', [
      OPS_PERMISSION.ENTITLEMENT_REQUEST,
      OPS_PERMISSION.ENTITLEMENT_APPROVE,
      OPS_PERMISSION.ENTITLEMENT_EXECUTE,
    ]);

    const keys = wrapper
      .findAll('[data-testid^="state-action-"]')
      .map((node) => node.attributes('data-testid'));

    expect(keys).toEqual(['state-action-submit']);
    expect(wrapper.find('[data-testid="state-action-approve"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="state-action-execute"]').exists()).toBe(
      false,
    );
  }, 20_000);

  it('待审批：渲染审批/驳回，且缺少 entitlement.approve 时按钮禁用', async () => {
    const wrapper = await mountPanel('pending_approval', [
      OPS_PERMISSION.ENTITLEMENT_REQUEST,
    ]);

    const approve = wrapper.find<HTMLButtonElement>(
      '[data-testid="state-action-approve"]',
    );
    expect(approve.exists()).toBe(true);
    expect(approve.element.disabled).toBe(true);
    expect(wrapper.text()).toContain('当前账号缺少该动作码');
    // 每个动作都展示所需权限码
    expect(wrapper.text()).toContain('entitlement.approve');
  }, 20_000);

  it('生效中：只提供变更申请动作，没有「提交/审批/直接生效」入口', async () => {
    const wrapper = await mountPanel('active', [
      OPS_PERMISSION.ENTITLEMENT_REQUEST,
      OPS_PERMISSION.ENTITLEMENT_APPROVE,
    ]);

    const keys = wrapper
      .findAll('[data-testid^="state-action-"]')
      .map((node) => node.attributes('data-testid'));

    expect(keys).toContain('state-action-change-suspend');
    expect(keys).toContain('state-action-change-revoke');
    expect(keys).not.toContain('state-action-submit');
    expect(keys).not.toContain('state-action-approve');
    // 缩权动作被标记为高风险
    const suspend = wrapper.find('[data-testid="state-action-change-suspend"]');
    expect(suspend.text()).toContain('申请暂停');
    expect(
      wrapper.findAll('.ant-tag').some((tag) => tag.text() === '高风险'),
    ).toBe(true);
  }, 20_000);

  it('终态：没有任何动作按钮', async () => {
    const wrapper = await mountPanel('revoked', [
      OPS_PERMISSION.ENTITLEMENT_REQUEST,
      OPS_PERMISSION.ENTITLEMENT_APPROVE,
      OPS_PERMISSION.ENTITLEMENT_EXECUTE,
    ]);

    expect(wrapper.findAll('[data-testid^="state-action-"]')).toHaveLength(0);
    expect(wrapper.text()).toContain('终态');
  }, 20_000);

  it('点击后只上报动作，不由面板发请求', async () => {
    const wrapper = await mountPanel('draft', [
      OPS_PERMISSION.ENTITLEMENT_REQUEST,
    ]);
    await wrapper.find('[data-testid="state-action-submit"]').trigger('click');

    const emitted = wrapper.emitted('action');
    expect(emitted).toHaveLength(1);
    const first = emitted?.[0]?.[0] as undefined | { key?: string };
    expect(first?.key).toBe('submit');
  }, 20_000);
});
