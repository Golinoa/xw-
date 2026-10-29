import type { CommandSubmissionPayload } from '../composables/use-command-submission';

import type { TenantCommandAccepted } from '#/api/ops/tenant/types';

import { describe, expect, it, vi } from 'vitest';

import { useCommandSubmission } from '../composables/use-command-submission';

function accepted(
  idempotencyKey: string,
  status: TenantCommandAccepted['status'] = 'pending',
): TenantCommandAccepted {
  return {
    commandId: 'cmd-1',
    commandNo: 'TC-2026-000901',
    idempotencyKey,
    replayed: false,
    status,
  };
}

const context = {
  commandType: 'suspend' as const,
  expectedSyncVersion: 7,
  label: '暂停租户',
  mappingId: 'm-1',
  mappingNo: 'TM-2026-000401',
};

describe('命令下发：幂等键生命周期', () => {
  it('同一表单连续两次提交只发一次请求', async () => {
    let resolveCreate: ((value: TenantCommandAccepted) => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise<TenantCommandAccepted>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const submission = useCommandSubmission({ create });
    submission.openForm(context);
    submission.setReason('客户逾期暂停服务');
    submission.setAcknowledged(true);

    const first = submission.submit();
    const second = submission.submit();

    expect(create).toHaveBeenCalledTimes(1);
    expect(submission.submitting.value).toBe(true);

    const key = submission.idempotencyKey.value ?? '';
    resolveCreate?.(accepted(key));
    await Promise.all([first, second]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(submission.accepted.value?.commandId).toBe('cmd-1');
  }, 10_000);

  it('失败后再次提交复用同一个幂等键（同一次用户意图的重放）', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(accepted('key-reused'));
    const submission = useCommandSubmission({ create });
    submission.openForm(context);
    submission.setReason('客户逾期暂停服务');
    submission.setAcknowledged(true);

    await submission.submit();
    const firstKey = submission.idempotencyKey.value;
    expect(submission.error.value?.kind).toBe('unknown');
    // 失败后表单保持打开、键不变、原因保留
    expect(submission.open.value).toBe(true);
    expect(submission.reason.value).toBe('客户逾期暂停服务');

    await submission.submit();
    const secondKey = submission.idempotencyKey.value;

    expect(create).toHaveBeenCalledTimes(2);
    expect(firstKey).toBe(secondKey);
    expect(create.mock.calls[0]?.[0].idempotencyKey).toBe(firstKey);
    expect(create.mock.calls[1]?.[0].idempotencyKey).toBe(firstKey);
  });

  it('关闭表单后重新打开才生成新键（新意图）', () => {
    const create = vi.fn();
    const submission = useCommandSubmission({ create });
    submission.openForm(context);
    const firstKey = submission.idempotencyKey.value;
    submission.close();

    submission.openForm(context);
    expect(submission.idempotencyKey.value).not.toBe(firstKey);
  });
});

describe('命令下发：expected_sync_version 来源', () => {
  it('原样使用映射详情的 sync_version，不省略也不传 0', async () => {
    const create = vi.fn(async (payload: CommandSubmissionPayload) =>
      accepted(payload.idempotencyKey),
    );
    const submission = useCommandSubmission({ create });
    submission.openForm(context);
    submission.setReason('暂停');
    submission.setAcknowledged(true);

    await submission.submit();

    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0]?.[0];
    expect(payload?.input.expectedSyncVersion).toBe(7);
  });

  it('映射详情尚未加载（版本缺失）时阻止提交，不发请求', async () => {
    const create = vi.fn();
    const submission = useCommandSubmission({ create });
    submission.openForm({ ...context, expectedSyncVersion: undefined });
    submission.setReason('暂停');
    submission.setAcknowledged(true);

    await submission.submit();

    expect(create).not.toHaveBeenCalled();
    expect(submission.error.value?.title).toBe('缺少同步版本');
    expect(submission.error.value?.shouldRefresh).toBe(true);
  });
});

describe('命令下发：前置校验', () => {
  it('未填写原因不发请求', async () => {
    const create = vi.fn();
    const submission = useCommandSubmission({ create });
    submission.openForm(context);

    await submission.submit();

    expect(create).not.toHaveBeenCalled();
    expect(submission.reasonError.value).toContain('原因');
  });

  it('高风险命令未勾选确认时不下发', async () => {
    const create = vi.fn();
    const submission = useCommandSubmission({ create });
    submission.openForm(context);
    submission.setReason('暂停');
    submission.setAcknowledged(false);

    await submission.submit();

    expect(create).not.toHaveBeenCalled();
    expect(submission.highRisk.value).toBe(true);
    expect(submission.acknowledgedError.value).toContain('勾选');
  });
});
