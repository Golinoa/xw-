import { describe, expect, it, vi } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';

import { useHighRiskAction } from '../composables/use-high-risk-action';

function conflictError(): OpsApiError {
  return new OpsApiError({
    code: 'STATE_CONFLICT',
    details: { reason: 'RECEIVABLE_EXCEEDED' },
    kind: 'http',
    reason: 'RECEIVABLE_EXCEEDED',
    requestId: 'req-123',
    retryable: false,
    status: 409,
    userMessage: 'x',
  });
}

const summary = {
  impact: '审核通过后计入实收',
  rows: [{ label: '收款金额', value: '¥86,000.00' }],
  title: '审核收款',
};

describe('高风险动作：二次确认与防重复提交', () => {
  it('打开确认弹窗不发请求（必须由用户显式确认）', () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const action = useHighRiskAction({ actionLabel: '审核收款', execute });

    action.prepare(summary);

    expect(action.open.value).toBe(true);
    expect(action.summary.value?.title).toBe('审核收款');
    expect(execute).not.toHaveBeenCalled();
  });

  it('未填原因不发请求，并给出必填提示', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const action = useHighRiskAction({ actionLabel: '审核收款', execute });
    action.prepare(summary);

    await action.confirm();

    expect(execute).not.toHaveBeenCalled();
    expect(action.reasonError.value).toContain('原因');
    expect(action.open.value).toBe(true);
  });

  it('提交中重复点击只发一次请求', async () => {
    let resolveExecute: ((value: string) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveExecute = resolve;
        }),
    );
    const action = useHighRiskAction({ actionLabel: '核销', execute });
    action.prepare(summary);
    action.reason.value = '核销到二期';

    const first = action.confirm();
    const second = action.confirm();

    expect(action.submitting.value).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    resolveExecute?.('done');
    await Promise.all([first, second]);

    expect(action.submitting.value).toBe(false);
    expect(action.open.value).toBe(false);
    expect(action.reason.value).toBe('');
  });

  it('失败时保留已填原因，并保留 requestId 供对账', async () => {
    const execute = vi.fn().mockRejectedValue(conflictError());
    const action = useHighRiskAction({ actionLabel: '核销', execute });
    action.prepare(summary);
    action.reason.value = '核销到二期应收';

    const result = await action.confirm();

    expect(result).toBeUndefined();
    expect(action.reason.value).toBe('核销到二期应收');
    expect(action.open.value).toBe(true);
    expect(action.error.value?.title).toBe('余额已变化');
    expect(action.error.value?.requestId).toBe('req-123');
    expect(action.submitting.value).toBe(false);
  });

  it('成功回调后由调用方刷新，不吞掉返回值', async () => {
    const execute = vi.fn().mockResolvedValue({ id: 'r-1' });
    const onSuccess = vi.fn();
    const action = useHighRiskAction({
      actionLabel: '审核收款',
      execute,
      onSuccess,
    });
    action.prepare(summary);
    action.reason.value = '复核无误';

    const result = await action.confirm();

    expect(result).toEqual({ id: 'r-1' });
    expect(onSuccess).toHaveBeenCalledWith({ id: 'r-1' });
    expect(execute).toHaveBeenCalledWith({ reason: '复核无误' });
  });

  it('提交中不允许关闭弹窗（避免中途丢失上下文）', async () => {
    let release: (value: string) => void = () => {};
    const execute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const action = useHighRiskAction({ actionLabel: '冲正', execute });
    action.prepare(summary);
    action.reason.value = '重复登记冲正';

    const pending = action.confirm();
    action.cancel();

    expect(action.open.value).toBe(true);

    release('done');
    await pending;
    expect(action.open.value).toBe(false);
  });
});
