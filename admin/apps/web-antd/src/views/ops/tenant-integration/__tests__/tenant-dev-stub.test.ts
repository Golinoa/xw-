import { beforeEach, describe, expect, it } from 'vitest';

import {
  resetStubTenantState,
  stubCancelCommand,
  stubCreateCommand,
  stubCreateMapping,
  stubGetCommand,
  stubGetMapping,
  stubListCommands,
  stubRetryCommand,
} from '#/api/ops/tenant/dev-stub';
import { STUB_UDONE_ORGS } from '#/api/ops/tenant/fixtures';

/** 虚构客户「示例旅行社丁」的 ID（见 `fixtures.ts`，用字面量避免非空断言）。 */
const DING_CUSTOMER_ID = '11111111-1111-4111-8111-111111111104';

const ACTIVE_MAPPING = '44444444-4444-4444-8444-444444444401';
const DRIFT_MAPPING = '44444444-4444-4444-8444-444444444404';
const PERMANENT_COMMAND = '55555555-5555-4555-8555-555555555503';
const TRANSIENT_COMMAND = '55555555-5555-4555-8555-555555555502';
const PENDING_COMMAND = '55555555-5555-4555-8555-555555555504';

const commandInput = {
  commandType: 'sync_entitlement' as const,
  expectedSyncVersion: 7,
  reason: '新增功能键后同步权益（虚构）',
};

beforeEach(() => {
  resetStubTenantState();
});

describe('桩：双重幂等', () => {
  it('同一幂等键重复下发只产生一条命令（重放而不是新建）', async () => {
    const first = await stubCreateCommand(
      ACTIVE_MAPPING,
      commandInput,
      'key-a',
    );
    const second = await stubCreateCommand(
      ACTIVE_MAPPING,
      commandInput,
      'key-a',
    );

    expect(second.commandId).toBe(first.commandId);
    const list = await stubListCommands({ mappingId: ACTIVE_MAPPING });
    const matched = list.items.filter(
      (item) => item.commandNo === first.commandNo,
    );
    expect(matched).toHaveLength(1);
  }, 10_000);

  it('202 受理结果保持 pending（不是成功）', async () => {
    const accepted = await stubCreateCommand(
      ACTIVE_MAPPING,
      commandInput,
      'key-b',
    );

    expect(accepted.status).toBe('pending');
    const detail = await stubGetCommand(accepted.commandId);
    expect(detail.command.status).toBe('pending');
    expect(detail.command.attemptCount).toBe(0);
    expect(detail.retryable).toBe(false);
  }, 10_000);
});

describe('桩：版本冲突', () => {
  it('sync_version 已被推进时返回 409 STATE_CONFLICT + SYNC_VERSION_CONFLICT', async () => {
    // DRIFT_MAPPING 的当前版本是 5，桩在第一次下发时模拟并发推进到 6。
    await expect(
      stubCreateCommand(
        DRIFT_MAPPING,
        { ...commandInput, expectedSyncVersion: 5 },
        'key-c',
      ),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      reason: 'SYNC_VERSION_CONFLICT',
      status: 409,
    });

    const detail = await stubGetMapping(DRIFT_MAPPING);
    expect(detail.mapping.syncVersion).toBe(6);
  }, 10_000);
});

describe('桩：失败与重试', () => {
  it('permanent 命令重试被拒绝（409 PERMANENT_ERROR）', async () => {
    const detail = await stubGetCommand(PERMANENT_COMMAND);
    expect(detail.command.lastErrorCategory).toBe('permanent');
    expect(detail.retryable).toBe(false);

    await expect(
      stubRetryCommand(PERMANENT_COMMAND, { reason: '再试一次', version: 3 }),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      reason: 'PERMANENT_ERROR',
      status: 409,
    });
  }, 10_000);

  it('transient 命令可以重试，返回 retrying（仍是异步受理）', async () => {
    const result = await stubRetryCommand(TRANSIENT_COMMAND, {
      reason: '上游恢复后重试',
      version: 5,
    });

    expect(result.accepted.status).toBe('retrying');
    expect(result.command?.status).toBe('retrying');
  }, 10_000);
});

describe('桩：取消守卫', () => {
  it('已发生尝试的命令不能取消', async () => {
    await expect(
      stubCancelCommand(TRANSIENT_COMMAND, { reason: '取消', version: 5 }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT', status: 409 });
  }, 10_000);

  it('零次尝试的 pending 命令可以取消', async () => {
    const result = await stubCancelCommand(PENDING_COMMAND, {
      reason: '客户撤回开通申请',
      version: 1,
    });

    expect(result.command.status).toBe('cancelled');
  }, 10_000);
});

describe('桩：映射冲突', () => {
  it('外部租户 ID 已被占用时拒绝，不自动改绑', async () => {
    await expect(
      stubCreateMapping(
        {
          customerId: DING_CUSTOMER_ID,
          productId: 'prod-tour-saas-01',
          reason: '重复绑定演示',
          udoneOrganizationId: STUB_UDONE_ORGS.jia01,
        },
        'map-key-1',
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason: 'TENANT_MAPPING_CONFLICT',
      status: 409,
    });
  }, 10_000);
});
