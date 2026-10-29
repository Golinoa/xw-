import type { TenantCommandAccepted } from '#/api/ops/tenant/types';

import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_PREFIX,
  describeAcceptedCommand,
  describeRetryAccepted,
} from '../command-feedback';

function accepted(
  overrides: Partial<TenantCommandAccepted> = {},
): TenantCommandAccepted {
  return {
    commandId: 'cmd-1',
    commandNo: 'TC-2026-000901',
    idempotencyKey: 'key-1',
    replayed: false,
    status: 'pending',
    ...overrides,
  };
}

describe('202 受理文案：不得渲染成成功', () => {
  it('pending 受理展示「已受理，结果待确认」，不含「成功」字样', () => {
    const text = describeAcceptedCommand(accepted());

    expect(text.startsWith(ACCEPTED_PREFIX)).toBe(true);
    expect(text).toContain('TC-2026-000901');
    expect(text).toContain('待执行');
    expect(text).not.toContain('成功');
  });

  it('幂等重放时说明「本次没有新建命令」', () => {
    const text = describeAcceptedCommand(accepted({ replayed: true }));

    expect(text).toContain('幂等重放');
    expect(text).not.toContain('新建命令并已生效');
  });

  it('重试受理同样只说已受理，并提示仍可能失败', () => {
    const text = describeRetryAccepted('TC-2026-000902');

    expect(text.startsWith(ACCEPTED_PREFIX)).toBe(true);
    expect(text).toContain('可能仍失败');
  });
});
