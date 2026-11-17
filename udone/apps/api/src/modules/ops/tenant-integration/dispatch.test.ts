import { describe, expect, it, vi } from 'vitest';

import { dispatchOnce, type DispatchCommand, type DispatchPorts } from './dispatch';

function command(overrides: Partial<DispatchCommand> = {}): DispatchCommand {
  return {
    id: 'cmd-1',
    commandNo: 'CMD-000001',
    commandType: 'activate',
    mappingId: 'map-1',
    attemptCount: 0,
    expectedSyncVersion: 3,
    payload: { tenantId: 'org-1' },
    ...overrides,
  };
}

function ports(overrides: Partial<DispatchPorts> = {}): DispatchPorts {
  return {
    claim: vi.fn(async () => [command()]),
    deliver: vi.fn(async () => ({ outcome: 'succeeded' as const, httpStatus: 200 })),
    complete: vi.fn(async () => ({ status: 'ok' })),
    ...overrides,
  };
}

describe('dispatchOnce', () => {
  it('成功后回写 succeeded，并把总数算对', async () => {
    const fake = ports();
    const summary = await dispatchOnce('worker-1', fake, { limit: 5 });

    expect(fake.claim).toHaveBeenCalledWith('worker-1', 5);
    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(fake.complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cmd-1' }),
      expect.objectContaining({ outcome: 'succeeded', httpStatus: 200 }),
      'worker-1',
    );
  });

  it('下发抛错时按失败回写，不把异常抛给调用方', async () => {
    const fake = ports({
      deliver: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    const summary = await dispatchOnce('worker-1', fake);

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 });
    expect(fake.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'failed',
        errorCategory: 'unknown',
        errorCode: 'TENANT_API_ERROR',
      }),
      'worker-1',
    );
  });

  it('超时归为 transient，错误码可区分（这类才值得再试）', async () => {
    const fake = ports({
      deliver: vi.fn(
        (_command: DispatchCommand, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    });

    const summary = await dispatchOnce('worker-1', fake, { timeoutMs: 10 });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 });
    expect(fake.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'failed',
        errorCategory: 'transient',
        errorCode: 'TENANT_API_TIMEOUT',
      }),
      'worker-1',
    );
  });

  it('回写被拒（租约被回收 / 无映射）计入 skipped，不算成功也不重试', async () => {
    const fake = ports({
      complete: vi.fn(async () => ({ status: 'lease_expired' })),
    });

    const summary = await dispatchOnce('worker-1', fake);

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 0, skipped: 1 });
  });

  it('没有可认领的命令时什么都不做', async () => {
    const fake = ports({ claim: vi.fn(async () => []) });

    const summary = await dispatchOnce('worker-1', fake);

    expect(summary).toEqual({ claimed: 0, succeeded: 0, failed: 0, skipped: 0 });
    expect(fake.deliver).not.toHaveBeenCalled();
    expect(fake.complete).not.toHaveBeenCalled();
  });

  it('一条失败不影响同一批里的下一条', async () => {
    const fake = ports({
      claim: vi.fn(async () => [
        command({ id: 'cmd-1' }),
        command({ id: 'cmd-2', commandNo: 'CMD-000002' }),
      ]),
      deliver: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ outcome: 'succeeded', httpStatus: 200 }),
    });

    const summary = await dispatchOnce('worker-1', fake);

    expect(summary).toEqual({ claimed: 2, succeeded: 1, failed: 1, skipped: 0 });
    expect(fake.complete).toHaveBeenCalledTimes(2);
  });
});
