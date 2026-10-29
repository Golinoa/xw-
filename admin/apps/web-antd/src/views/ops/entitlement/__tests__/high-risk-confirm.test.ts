import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';

import { useEntitlementHighRisk } from '../composables/use-entitlement-high-risk';

/**
 * 高风险动作（审批 / 撤销·暂停的执行）：必须二次确认、原因必填、未确认不发请求。
 *
 * 这里覆盖提交状态机本身；弹窗只负责收集与呈现，不直接发请求。
 */
const SUMMARY = {
  impact: '撤销后客户立即失去已购功能，且历史快照保留不可改写。',
  rows: [
    { emphasis: true, label: '对象', value: 'SUB-2026-000801' },
    { label: '动作', value: '执行变更并下发同步' },
  ],
  title: '执行变更并下发同步',
};

function approvalRequiredError(): OpsApiError {
  return new OpsApiError({
    code: 'STATE_CONFLICT',
    details: { reason: 'APPROVAL_REQUIRED' },
    kind: 'http',
    reason: 'APPROVAL_REQUIRED',
    requestId: 'req-confirm-1',
    retryable: false,
    status: 409,
    userMessage: 'x',
  });
}

describe('高风险动作确认', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('打开确认弹窗不发请求', () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const action = useEntitlementHighRisk({ actionLabel: '执行', execute });

    action.prepare(SUMMARY);

    expect(action.open.value).toBe(true);
    expect(action.summary.value?.title).toBe('执行变更并下发同步');
    expect(execute).not.toHaveBeenCalled();
  }, 20_000);

  it('未填原因不发请求，并给出必填提示', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const action = useEntitlementHighRisk({ actionLabel: '执行', execute });
    action.prepare(SUMMARY);

    const result = await action.confirm();

    expect(result).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(action.reasonError.value).toContain('原因');
    expect(action.open.value).toBe(true);
  }, 20_000);

  it('填写原因后才提交，并把 trim 后的原因传给服务端', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'executed' });
    const onSuccess = vi.fn();
    const action = useEntitlementHighRisk({
      actionLabel: '执行',
      execute,
      onSuccess,
    });
    action.prepare(SUMMARY);
    action.reason.value = '  客户欠费，按合同暂停服务  ';

    const result = await action.confirm();

    expect(execute).toHaveBeenCalledWith({
      reason: '客户欠费，按合同暂停服务',
    });
    expect(result).toEqual({ status: 'executed' });
    expect(action.open.value).toBe(false);
    expect(onSuccess).toHaveBeenCalledOnce();
  }, 20_000);

  it('提交中重复点击只发一次请求', async () => {
    let release: (value: string) => void = () => {};
    const execute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const action = useEntitlementHighRisk({ actionLabel: '执行', execute });
    action.prepare(SUMMARY);
    action.reason.value = '重复提交测试';

    const first = action.confirm();
    const second = action.confirm();

    expect(execute).toHaveBeenCalledTimes(1);
    release('ok');
    await Promise.all([first, second]);
    expect(action.submitting.value).toBe(false);
  }, 20_000);

  it('失败保留原因并映射 409 APPROVAL_REQUIRED 文案', async () => {
    const execute = vi.fn().mockRejectedValue(approvalRequiredError());
    const action = useEntitlementHighRisk({ actionLabel: '执行', execute });
    action.prepare(SUMMARY);
    action.reason.value = '客户催促执行';

    const result = await action.confirm();

    expect(result).toBeUndefined();
    expect(action.reason.value).toBe('客户催促执行');
    expect(action.open.value).toBe(true);
    expect(action.error.value?.title).toBe('需要先完成审批');
    expect(action.error.value?.shouldRefresh).toBe(true);
    expect(action.error.value?.requestId).toBe('req-confirm-1');
  }, 20_000);

  it('弹窗展示影响摘要与原因错误，确认按钮只上报事件', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: HighRiskModal } =
      await import('../components/high-risk-modal.vue');
    const wrapper = mount(HighRiskModal, {
      attachTo: document.body,
      props: {
        actionLabel: '执行变更',
        error: null,
        open: true,
        reason: '',
        reasonError: '请填写操作原因（会写入审计，便于事后追溯）',
        submitting: false,
        summary: SUMMARY,
      },
    });

    await vi.waitFor(
      () => {
        expect(document.body.textContent).toContain('二次确认');
      },
      { timeout: 10_000 },
    );

    expect(document.body.textContent).toContain('撤销后客户立即失去已购功能');
    expect(document.body.textContent).toContain('请填写操作原因');
    expect(document.body.textContent).toContain('必填');

    const okButton = document.body.querySelector<HTMLButtonElement>(
      '.ant-modal-footer .ant-btn-primary',
    );
    expect(okButton).not.toBeNull();
    okButton?.click();

    await vi.waitFor(
      () => {
        expect(wrapper.emitted('confirm')).toHaveLength(1);
      },
      { timeout: 10_000 },
    );

    wrapper.unmount();
  }, 20_000);
});
