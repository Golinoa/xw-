/**
 * 租户命令 API（契约 §5.7）：下发（202）、查询、尝试记录、重试、取消。
 *
 * 三条不可让步的语义：
 * 1. **202 只表示已受理**：返回 `status='pending'`（或既有命令状态），页面必须
 *    展示「已受理，结果待确认」，不能渲染成成功；
 * 2. **重试复用原幂等键**（契约 §2.5 双重幂等）：`retryCommand` 用命令详情里的
 *    `idempotencyKey` 作 `Idempotency-Key`，不生成新键；
 * 3. 尝试记录是审计核心，单独提供 `fetchCommandAttempts` 供抽屉刷新。
 */
import type {
  CancelTenantCommandInput,
  CancelTenantCommandResult,
  CreateTenantCommandInput,
  RetryTenantCommandInput,
  RetryTenantCommandResult,
  TenantCommandAccepted,
  TenantCommandAcceptedWire,
  TenantCommandAttempt,
  TenantCommandDetail,
  TenantCommandListQuery,
  TenantCommandListResult,
} from './types';

import {
  buildCommandListParams,
  requestClient,
  TENANT_ENDPOINTS,
  writeConfig,
} from './endpoints';

/**
 * 归一化 202 响应：兼容契约 §2.4（`{commandId,status,idempotencyKey}`）与
 * §5.7（`command{...}`）两种形态。
 *
 * 关键点：`status` 缺省时按 `pending` 处理（202 的语义就是「已受理待执行」），
 * 但**绝不**把 `succeeded` 当成默认值。
 */
export function normalizeAccepted(
  raw: TenantCommandAcceptedWire,
  fallbackIdempotencyKey: string,
  replayed = false,
): TenantCommandAccepted {
  const command = raw.command;
  const commandId = raw.commandId ?? command?.id ?? '';
  if (commandId === '') {
    // 没有命令 ID 就无法查询结果，视为契约违约，交给上层按未知错误处理。
    throw new Error('202 响应缺少 commandId，无法跟踪命令状态');
  }
  const accepted: TenantCommandAccepted = {
    commandId,
    idempotencyKey:
      raw.idempotencyKey ?? command?.idempotencyKey ?? fallbackIdempotencyKey,
    replayed,
    status: raw.status ?? command?.status ?? 'pending',
  };
  const commandNo = raw.commandNo ?? command?.commandNo;
  if (commandNo !== undefined) {
    accepted.commandNo = commandNo;
  }
  return accepted;
}

/** 命令列表（服务端分页：映射 / 状态[] / 类型 / 创建时间）。 */
export async function fetchCommands(
  query: TenantCommandListQuery = {},
): Promise<TenantCommandListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListCommands } = await import('./dev-stub');
    return stubListCommands(query);
  }
  return requestClient.get<TenantCommandListResult>(TENANT_ENDPOINTS.commands, {
    params: buildCommandListParams(query),
  });
}

/** 命令详情：命令体 + 请求/响应摘要 + 尝试记录 + `retryable`。 */
export async function fetchCommand(
  commandId: string,
): Promise<TenantCommandDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetCommand } = await import('./dev-stub');
    return stubGetCommand(commandId);
  }
  return requestClient.get<TenantCommandDetail>(
    TENANT_ENDPOINTS.command(commandId),
  );
}

/** 尝试记录（仅 INSERT 的审计流水）。 */
export async function fetchCommandAttempts(
  commandId: string,
): Promise<TenantCommandAttempt[]> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetCommandAttempts } = await import('./dev-stub');
    return stubGetCommandAttempts(commandId);
  }
  const result = await requestClient.get<{ items: TenantCommandAttempt[] }>(
    TENANT_ENDPOINTS.commandAttempts(commandId),
  );
  return result.items;
}

/**
 * 下发命令（契约 §5.7：202 + 命令体）。
 *
 * `idempotencyKey` **必须由表单生成并复用**：这里不接受缺省值，
 * 避免「每次提交都新生成键」导致同一次用户意图产生多条命令。
 */
export async function createCommand(
  mappingId: string,
  input: CreateTenantCommandInput,
  idempotencyKey: string,
): Promise<TenantCommandAccepted> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateCommand } = await import('./dev-stub');
    return stubCreateCommand(mappingId, input, idempotencyKey);
  }
  const raw = await requestClient.post<TenantCommandAcceptedWire>(
    TENANT_ENDPOINTS.mappingCommands(mappingId),
    input,
    writeConfig(idempotencyKey),
  );
  return normalizeAccepted(raw, idempotencyKey);
}

/**
 * 重试失败命令（202）。
 *
 * 幂等键**复用原命令的键**（契约 §2.5：「重试复用同一个 key」），
 * 而不是新生成——否则同一重试意图在服务端会被视为新命令。
 */
export async function retryCommand(
  command: { id: string; idempotencyKey?: null | string },
  input: RetryTenantCommandInput,
): Promise<RetryTenantCommandResult> {
  const idempotencyKey = command.idempotencyKey ?? '';
  if (idempotencyKey === '') {
    // 没有原键就无法保证「重试不重复执行」，宁可拦住也不发一个会新建命令的请求。
    throw new Error(
      '命令详情缺少 idempotency_key，无法安全重试（重试必须复用原幂等键）',
    );
  }
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubRetryCommand } = await import('./dev-stub');
    return stubRetryCommand(command.id, input);
  }
  const raw = await requestClient.post<TenantCommandAcceptedWire>(
    TENANT_ENDPOINTS.commandRetry(command.id),
    input,
    writeConfig(idempotencyKey),
  );
  return {
    accepted: normalizeAccepted(raw, idempotencyKey),
    ...(raw.command ? { command: raw.command } : {}),
  };
}

/** 取消命令：仅「零次尝试」的 `pending` 命令可取消（服务端同样守此规则）。 */
export async function cancelCommand(
  commandId: string,
  input: CancelTenantCommandInput,
  idempotencyKey: string,
): Promise<CancelTenantCommandResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCancelCommand } = await import('./dev-stub');
    return stubCancelCommand(commandId, input);
  }
  return requestClient.post<CancelTenantCommandResult>(
    TENANT_ENDPOINTS.commandCancel(commandId),
    input,
    writeConfig(idempotencyKey),
  );
}
