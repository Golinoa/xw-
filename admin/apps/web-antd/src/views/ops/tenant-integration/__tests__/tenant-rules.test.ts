import type { ComposeCommandResult } from '#/api/ops/tenant/rules';

import { describe, expect, it } from 'vitest';

import {
  canCancelCommand,
  canEditMappingExternalId,
  canRetryCommand,
  commandPermission,
  commandRequiresHighRisk,
  composeCommandInput,
  validateReason,
} from '#/api/ops/tenant/rules';

/** 断言组装失败并返回收窄后的失败对象（避免在 if 分支里写 expect）。 */
function expectComposeFailure(result: ComposeCommandResult) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('预期命令组装失败，实际返回成功');
  }
  return result;
}

describe('重试可用性', () => {
  it('permanent 错误：禁用重试并说明「永久性错误不可重试」', () => {
    const decision = canRetryCommand({
      hasPermission: true,
      lastErrorCategory: 'permanent',
      serverRetryable: true,
      status: 'failed',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('permanent_error');
    expect(decision.message).toContain('永久性错误不可重试');
  });

  it('permanent 优先于「服务端说可重试」：双保险，禁止放行', () => {
    const decision = canRetryCommand({
      hasPermission: true,
      lastErrorCategory: 'permanent',
      serverRetryable: true,
      status: 'failed',
    });

    expect(decision.allowed).toBe(false);
  });

  it('transient 失败：允许重试', () => {
    const decision = canRetryCommand({
      hasPermission: true,
      lastErrorCategory: 'transient',
      serverRetryable: true,
      status: 'failed',
    });

    expect(decision.allowed).toBe(true);
  });

  it('非 failed 状态不可重试（如 pending / succeeded）', () => {
    expect(
      canRetryCommand({
        hasPermission: true,
        lastErrorCategory: null,
        serverRetryable: true,
        status: 'pending',
      }).code,
    ).toBe('state');
    expect(
      canRetryCommand({
        hasPermission: true,
        lastErrorCategory: null,
        serverRetryable: true,
        status: 'succeeded',
      }).allowed,
    ).toBe(false);
  });

  it('缺少 tenant.retry 时不可重试', () => {
    expect(
      canRetryCommand({
        hasPermission: false,
        lastErrorCategory: 'transient',
        status: 'failed',
      }).code,
    ).toBe('permission');
  });
});

describe('取消可用性', () => {
  it('已发生尝试（attempt_count > 0）时禁用取消并说明次数', () => {
    const decision = canCancelCommand({
      attemptCount: 2,
      hasPermission: true,
      status: 'pending',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('attempted');
    expect(decision.message).toContain('2 次');
  });

  it('零次尝试的 pending 命令可以取消', () => {
    const decision = canCancelCommand({
      attemptCount: 0,
      hasPermission: true,
      status: 'pending',
    });

    expect(decision.allowed).toBe(true);
  });

  it('succeeded 不可取消（成功执行不可删除）', () => {
    expect(
      canCancelCommand({
        attemptCount: 0,
        hasPermission: true,
        status: 'succeeded',
      }).code,
    ).toBe('not_pending');
  });
});

describe('命令体组装', () => {
  const draft = { commandType: 'suspend' as const };

  it('expected_sync_version 原样采用映射详情值', () => {
    const result = composeCommandInput({
      draft,
      expectedSyncVersion: 7,
      reason: '逾期暂停',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        commandType: 'suspend',
        expectedSyncVersion: 7,
        reason: '逾期暂停',
      },
    });
  });

  it('缺少版本时拒绝组装（不得用 0 兜底）', () => {
    const failure = expectComposeFailure(
      composeCommandInput({
        draft,
        expectedSyncVersion: undefined,
        reason: '逾期暂停',
      }),
    );

    expect(failure.code).toBe('version_missing');
    expect(failure.message).toContain('sync_version');
  });

  it('负数或非整数版本同样拒绝', () => {
    expect(
      composeCommandInput({ draft, expectedSyncVersion: -1, reason: 'x' }).ok,
    ).toBe(false);
    expect(
      composeCommandInput({ draft, expectedSyncVersion: 1.5, reason: 'x' }).ok,
    ).toBe(false);
  });

  it('原因必填', () => {
    const failure = expectComposeFailure(
      composeCommandInput({
        draft,
        expectedSyncVersion: 0,
        reason: '   ',
      }),
    );

    expect(failure.code).toBe('reason_required');
  });

  it('原因超长被拒绝', () => {
    expect(validateReason('x'.repeat(501)).ok).toBe(false);
  });
});

describe('动作码映射与高风险判定', () => {
  it('按 command_type 映射到契约 §3.6 的动作码', () => {
    expect(commandPermission('provision')).toBe('tenant.provision');
    expect(commandPermission('bind')).toBe('tenant.provision');
    expect(commandPermission('activate')).toBe('tenant.provision');
    expect(commandPermission('suspend')).toBe('tenant.suspend');
    expect(commandPermission('resume')).toBe('tenant.restore');
    expect(commandPermission('sync_entitlement')).toBe('entitlement.execute');
    expect(commandPermission('extend')).toBe('entitlement.execute');
    expect(commandPermission('revoke')).toBe('entitlement.execute');
  });

  it('暂停与撤销权益必须走高风险二次确认', () => {
    expect(commandRequiresHighRisk('suspend')).toBe(true);
    expect(commandRequiresHighRisk('revoke')).toBe(true);
  });
});

describe('映射可编辑性', () => {
  it('非 pending 映射不可改外部租户 ID', () => {
    const decision = canEditMappingExternalId({
      hasPermission: true,
      status: 'active',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain('不可再改');
  });

  it('pending 映射允许修改', () => {
    expect(
      canEditMappingExternalId({ hasPermission: true, status: 'pending' })
        .allowed,
    ).toBe(true);
  });
});
