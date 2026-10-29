import type {
  CancelTenantCommandInput,
  CancelTenantCommandResult,
  CreateTenantCommandInput,
  CreateTenantMappingInput,
  CreateTenantMappingResult,
  RetryTenantCommandInput,
  RetryTenantCommandResult,
  TenantCommand,
  TenantCommandAccepted,
  TenantCommandAttempt,
  TenantCommandDetail,
  TenantCommandListQuery,
  TenantCommandListResult,
  TenantCommandStatus,
  TenantCommandType,
  TenantMapping,
  TenantMappingDetail,
  TenantMappingListQuery,
  TenantMappingListResult,
  TenantMappingStatus,
  UpdateTenantMappingInput,
  UpdateTenantMappingResult,
} from './types';

/**
 * 开发态租户交付契约桩（仅在 `VITE_OPS_MOCK=true` 的非生产构建里被动态加载）。
 *
 * 目的：在 `udone` 的租户命令端点尚未交付时，页面能走通全部交付状态
 * （loading / empty / error / validation / permission / conflict / destructive），
 * 且**不冒充真实集成**——页面同时展示「开发态数据」提示。
 *
 * 桩刻意复刻服务端不变量（否则前端会在假成功里漏掉真实错误分支）：
 * - 幂等键重复 → 返回既有命令（`replayed=true`），不新建；
 * - `expectedSyncVersion` ≠ `mapping.syncVersion` → 409 `STATE_CONFLICT` +
 *   `SYNC_VERSION_CONFLICT`（该 reason 尚未进入契约 §6.4 词表，已登记待确认）；
 * - `udone_organization_id` 已被占用 → 409 `CONFLICT` + `TENANT_MAPPING_CONFLICT`；
 * - 永久性失败命令重试 → 409 `STATE_CONFLICT` + `PERMANENT_ERROR`；
 * - 已发生尝试的命令取消 → 409 `STATE_CONFLICT`；
 * - 非 `pending` 映射改外部 ID → 409 `STATE_CONFLICT`。
 */
import { OpsApiError, resolveUserMessage } from '#/api/adapter/errors';

import {
  STUB_TENANT_ATTEMPTS,
  STUB_TENANT_COMMANDS,
  STUB_TENANT_CUSTOMERS,
  STUB_TENANT_MAPPINGS,
  STUB_UDONE_ORGS,
  stubCustomerRef,
} from './fixtures';

const STUB_LATENCY_MS = 120;
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_WHITELIST = new Set([10, 15, 20, 30, 50, 100]);
const RECENT_COMMAND_LIMIT = 20;

interface StubState {
  attempts: typeof STUB_TENANT_ATTEMPTS;
  commands: typeof STUB_TENANT_COMMANDS;
  mappings: typeof STUB_TENANT_MAPPINGS;
  /** 映射创建幂等：key → mappingId（复刻 `ops.idempotency_records` 的效果）。 */
  mappingKeys: Map<string, string>;
  sequence: number;
}

function cloneState(): StubState {
  return {
    attempts: STUB_TENANT_ATTEMPTS.map((row) => ({ ...row })),
    commands: STUB_TENANT_COMMANDS.map((row) => ({ ...row })),
    mappings: STUB_TENANT_MAPPINGS.map((row) => ({ ...row })),
    mappingKeys: new Map(),
    sequence: 900,
  };
}

let state: StubState = cloneState();

/** 仅供单测重置桩状态。 */
export function resetStubTenantState(): void {
  state = cloneState();
}

function respond<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), STUB_LATENCY_MS);
  });
}

function fail(options: {
  code: string;
  message?: string;
  reason?: string;
  status: number;
}): never {
  throw new OpsApiError({
    code: options.code,
    details: options.reason ? { reason: options.reason } : undefined,
    kind: 'http',
    reason: options.reason,
    retryable: false,
    status: options.status,
    userMessage:
      options.message ?? resolveUserMessage(options.code, options.reason),
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextNo(prefix: string): string {
  state.sequence += 1;
  return `${prefix}-${state.sequence}`;
}

/**
 * 桩内生成 UUID 形态的 ID（不依赖 `crypto.randomUUID` 是否存在，
 * 也不产生随机碰撞导致测试不可重复）。
 */
function nextId(): string {
  state.sequence += 1;
  return `66666666-6666-4666-8666-${String(state.sequence).padStart(12, '0')}`;
}

function paginate<T>(items: T[], page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const size = PAGE_SIZE_WHITELIST.has(pageSize) ? pageSize : DEFAULT_PAGE_SIZE;
  const current = Math.max(1, page);
  return {
    items: items.slice((current - 1) * size, current * size),
    page: current,
    pageSize: size,
    total: items.length,
  };
}

function toMapping(row: (typeof STUB_TENANT_MAPPINGS)[number]): TenantMapping {
  return {
    customer: stubCustomerRef(row.customerKey),
    externalRef: row.externalRef ?? null,
    id: row.id,
    lastKnownState: row.lastKnownState ?? null,
    lastSyncedAt: row.lastSyncedAt ?? null,
    mappingNo: row.mappingNo,
    mappingStatus: row.mappingStatus,
    productId: row.productId,
    syncVersion: row.syncVersion,
    udoneOrganizationId: row.udoneOrganizationId,
    version: row.version,
  };
}

function toCommand(row: (typeof STUB_TENANT_COMMANDS)[number]): TenantCommand {
  return {
    attemptCount: row.attemptCount,
    commandNo: row.commandNo,
    commandType: row.commandType,
    completedAt: row.completedAt ?? null,
    contractId: row.contractId ?? null,
    createdAt: row.createdAt,
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    lastErrorCategory: row.lastErrorCategory ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
    mappingId: row.mappingId,
    nextRetryAt: row.nextRetryAt ?? null,
    reason: row.reason,
    requestId: row.requestId ?? null,
    status: row.status,
    version: row.version,
  };
}

function mappingRowById(
  mappingId: string,
): (typeof STUB_TENANT_MAPPINGS)[number] {
  const row = state.mappings.find((item) => item.id === mappingId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

function commandRowById(
  commandId: string,
): (typeof STUB_TENANT_COMMANDS)[number] {
  const row = state.commands.find((item) => item.id === commandId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

function commandsSortedDesc(mappingId?: string) {
  const rows = mappingId
    ? state.commands.filter((row) => row.mappingId === mappingId)
    : [...state.commands];
  return rows.toSorted((left, right) =>
    left.createdAt < right.createdAt ? 1 : -1,
  );
}

function attemptsOf(commandId: string): TenantCommandAttempt[] {
  return state.attempts
    .filter((row) => row.commandId === commandId)
    .toSorted((left, right) => left.attemptNo - right.attemptNo)
    .map((row) => ({
      attemptNo: row.attemptNo,
      errorCategory: row.errorCategory ?? null,
      finishedAt: row.finishedAt ?? null,
      httpStatus: row.httpStatus ?? null,
      outcome: row.outcome,
      requestId: row.requestId ?? null,
      startedAt: row.startedAt,
    }));
}

// ---------------------------------------------------------------- 映射

export async function stubListMappings(
  query: TenantMappingListQuery = {},
): Promise<TenantMappingListResult> {
  let rows = [...state.mappings];
  if (query.customerId) {
    rows = rows.filter(
      (row) => STUB_TENANT_CUSTOMERS[row.customerKey]?.id === query.customerId,
    );
  }
  if (query.productId) {
    rows = rows.filter((row) => row.productId === query.productId);
  }
  if (query.mappingStatus) {
    rows = rows.filter((row) => row.mappingStatus === query.mappingStatus);
  }
  if (typeof query.syncVersion === 'number') {
    rows = rows.filter((row) => row.syncVersion === query.syncVersion);
  }
  const items = rows
    .toSorted((left, right) => (left.mappingNo < right.mappingNo ? 1 : -1))
    .map((row) => toMapping(row));
  return respond(paginate(items, query.page, query.pageSize));
}

export async function stubGetMapping(
  mappingId: string,
): Promise<TenantMappingDetail> {
  const row = mappingRowById(mappingId);
  return respond({
    commands: commandsSortedDesc(mappingId)
      .slice(0, RECENT_COMMAND_LIMIT)
      .map((item) => toCommand(item)),
    mapping: toMapping(row),
  });
}

export async function stubCreateMapping(
  input: CreateTenantMappingInput,
  idempotencyKey = '',
): Promise<CreateTenantMappingResult> {
  if (input.reason.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  const existingId = idempotencyKey
    ? state.mappingKeys.get(idempotencyKey)
    : undefined;
  if (existingId) {
    const existing = mappingRowById(existingId);
    return respond({ mapping: toMapping(existing) });
  }
  if (
    input.udoneOrganizationId &&
    state.mappings.some(
      (row) => row.udoneOrganizationId === input.udoneOrganizationId,
    )
  ) {
    fail({
      code: 'CONFLICT',
      reason: 'TENANT_MAPPING_CONFLICT',
      status: 409,
    });
  }
  const customerEntry = Object.entries(STUB_TENANT_CUSTOMERS).find(
    ([, item]) => item.id === input.customerId,
  );
  if (!customerEntry) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '客户不存在（开发态桩仅支持 fixtures 中的虚构客户）',
      status: 400,
    });
  }
  const [customerKey] = customerEntry;
  state.sequence += 1;
  const mappingNo = `TM-2026-${String(state.sequence).padStart(6, '0')}`;
  const row = {
    customerKey,
    externalRef: input.externalRef ?? null,
    id: nextId(),
    lastKnownState: 'pending',
    lastSyncedAt: null,
    mappingNo,
    mappingStatus: 'pending' as TenantMappingStatus,
    productId: input.productId,
    syncVersion: 0,
    udoneOrganizationId: input.udoneOrganizationId ?? STUB_UDONE_ORGS.occupied,
    version: 1,
  };
  state.mappings.push(row);
  if (idempotencyKey) {
    state.mappingKeys.set(idempotencyKey, row.id);
  }
  return respond({ mapping: toMapping(row) });
}

export async function stubUpdateMapping(
  mappingId: string,
  input: UpdateTenantMappingInput,
): Promise<UpdateTenantMappingResult> {
  const row = mappingRowById(mappingId);
  if (row.version !== input.version) {
    fail({
      code: 'CONFLICT',
      reason: 'SYNC_VERSION_CONFLICT',
      status: 409,
    });
  }
  if (
    input.udoneOrganizationId !== undefined &&
    input.udoneOrganizationId !== row.udoneOrganizationId
  ) {
    if (row.mappingStatus !== 'pending') {
      fail({ code: 'STATE_CONFLICT', status: 409 });
    }
    if (
      state.mappings.some(
        (item) =>
          item.id !== mappingId &&
          item.udoneOrganizationId === input.udoneOrganizationId,
      )
    ) {
      fail({
        code: 'CONFLICT',
        reason: 'TENANT_MAPPING_CONFLICT',
        status: 409,
      });
    }
    row.udoneOrganizationId = input.udoneOrganizationId;
  }
  if (input.externalRef !== undefined) {
    row.externalRef = input.externalRef;
  }
  row.version += 1;
  return respond({ mapping: toMapping(row) });
}

// ---------------------------------------------------------------- 命令

export async function stubListCommands(
  query: TenantCommandListQuery = {},
): Promise<TenantCommandListResult> {
  let rows = commandsSortedDesc(query.mappingId);
  if (query.commandType) {
    rows = rows.filter((row) => row.commandType === query.commandType);
  }
  if (query.status && query.status.length > 0) {
    const allowed = new Set<TenantCommandStatus>(query.status);
    rows = rows.filter((row) => allowed.has(row.status));
  }
  const { createdFrom, createdTo } = query;
  if (createdFrom) {
    rows = rows.filter((row) => row.createdAt >= createdFrom);
  }
  if (createdTo) {
    rows = rows.filter((row) => row.createdAt <= `${createdTo}T23:59:59Z`);
  }
  const items = rows.map((row) => toCommand(row));
  return respond(paginate(items, query.page, query.pageSize));
}

export async function stubGetCommand(
  commandId: string,
): Promise<TenantCommandDetail> {
  const row = commandRowById(commandId);
  return respond({
    attempts: attemptsOf(commandId),
    command: toCommand(row),
    requestSummary: {
      commandType: row.commandType,
      mappingId: row.mappingId,
    },
    responseSummary:
      row.status === 'succeeded'
        ? { syncVersionApplied: true }
        : { lastErrorCode: row.lastErrorCode ?? null },
    // 与服务端同一判定：只有 failed 且非 permanent 才可重试。
    retryable: row.status === 'failed' && row.lastErrorCategory !== 'permanent',
  });
}

export async function stubGetCommandAttempts(
  commandId: string,
): Promise<TenantCommandAttempt[]> {
  commandRowById(commandId);
  return respond(attemptsOf(commandId));
}

export async function stubCreateCommand(
  mappingId: string,
  input: CreateTenantCommandInput,
  idempotencyKey: string,
): Promise<TenantCommandAccepted> {
  const mapping = mappingRowById(mappingId);
  if (input.reason.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }

  // 双重幂等：同键直接返回既有命令（不新建、不重复下发）。
  const replay = state.commands.find(
    (row) => row.idempotencyKey === idempotencyKey,
  );
  if (replay) {
    return respond({
      command: toCommand(replay),
      commandId: replay.id,
      commandNo: replay.commandNo,
      idempotencyKey,
      replayed: true,
      status: replay.status,
    });
  }

  if (mapping.demoSyncVersionDrift) {
    // 模拟并发：另一位运营刚完成一次同步，服务端版本已前进。
    mapping.demoSyncVersionDrift = false;
    mapping.syncVersion += 1;
    mapping.version += 1;
  }

  if (input.expectedSyncVersion !== mapping.syncVersion) {
    fail({
      code: 'STATE_CONFLICT',
      reason: 'SYNC_VERSION_CONFLICT',
      status: 409,
    });
  }

  const commandNo = nextNo('TC-2026');
  const row = {
    attemptCount: 0,
    commandNo,
    commandType: input.commandType as TenantCommandType,
    completedAt: null,
    contractId: input.contractId ?? null,
    createdAt: nowIso(),
    id: nextId(),
    idempotencyKey,
    lastErrorCategory: null,
    lastErrorCode: null,
    mappingId,
    nextRetryAt: null,
    reason: input.reason,
    requestId: `req-${commandNo}`,
    status: 'pending' as TenantCommandStatus,
    version: 1,
  };
  state.commands.push(row);
  // 202 只表示已受理：命令保持 pending，最终结果由远端回调写回。
  return respond({
    command: toCommand(row),
    commandId: row.id,
    commandNo,
    idempotencyKey,
    replayed: false,
    status: 'pending',
  });
}

export async function stubRetryCommand(
  commandId: string,
  input: RetryTenantCommandInput,
): Promise<RetryTenantCommandResult> {
  const row = commandRowById(commandId);
  if (row.lastErrorCategory === 'permanent') {
    fail({
      code: 'STATE_CONFLICT',
      reason: 'PERMANENT_ERROR',
      status: 409,
    });
  }
  if (row.status !== 'failed') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (typeof input.version === 'number' && input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  row.status = 'retrying';
  row.version += 1;
  const command = toCommand(row);
  return respond({
    accepted: {
      commandId: row.id,
      commandNo: row.commandNo,
      idempotencyKey: row.idempotencyKey,
      replayed: false,
      status: 'retrying',
    },
    command,
  });
}

export async function stubCancelCommand(
  commandId: string,
  input: CancelTenantCommandInput,
): Promise<CancelTenantCommandResult> {
  const row = commandRowById(commandId);
  if (row.attemptCount > 0 || row.status !== 'pending') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (typeof input.version === 'number' && input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  row.status = 'cancelled';
  row.completedAt = nowIso();
  row.version += 1;
  return respond({ command: toCommand(row) });
}
