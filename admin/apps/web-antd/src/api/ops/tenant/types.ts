/**
 * 租户集成交付域类型（tenant-integration）。
 *
 * 真源：`Docs/ops-api-contract.md` §3.6（三张表 / 两套状态机 / 边界规则）与
 * §5.7（端点）。硬规则：
 * 1. 字段名、状态枚举、错误类别严格照抄契约，不造同义字段；
 * 2. ops 只保存 `udone_organization_id` / `external_ref` / `last_known_state` /
 *    `last_synced_at` / `sync_version`，**不复制**租户业务数据（契约 §2.7）；
 * 3. 命令是异步的：创建成功只代表「已受理」，最终结果只能看命令状态。
 */

/** 映射状态（契约 §3.6 `ops.tenant_mappings.mapping_status`）。 */
export type TenantMappingStatus =
  | 'active'
  | 'pending'
  | 'suspended'
  | 'terminated';

/**
 * 命令状态（契约 §3.6 状态机）。
 * `pending` 结果未知时可再次进入 `pending`（超时），因此不是严格单向。
 */
export type TenantCommandStatus =
  | 'cancelled'
  | 'failed'
  | 'pending'
  | 'retrying'
  | 'succeeded';

/** 命令类型（契约 §3.6 `command_type`）。 */
export type TenantCommandType =
  | 'activate'
  | 'bind'
  | 'extend'
  | 'provision'
  | 'resume'
  | 'revoke'
  | 'suspend'
  | 'sync_entitlement';

/**
 * 错误类别（契约 §3.6 `last_error_category`）。
 * `permanent` 的命令**禁止重试**（409 `STATE_CONFLICT` + `PERMANENT_ERROR`）。
 */
export type TenantErrorCategory =
  | 'auth'
  | 'conflict'
  | 'permanent'
  | 'transient'
  | 'unknown';

/** 单次尝试结果（契约 §3.6 `ops.tenant_command_attempts.outcome`）。 */
export type TenantAttemptOutcome = 'failed' | 'succeeded' | 'timeout';

/** 客户引用（契约 §5.7 列表响应内嵌 `customer{...}`）。 */
export interface TenantCustomerRef {
  customerNo?: string;
  id: string;
  name: string;
}

/** 分页查询公共参数（契约 §2.4）。 */
export interface TenantListQuery {
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  sort?: string;
}

/** 分页响应公共形态（契约 §2.4）。 */
export interface TenantPagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// ---------------------------------------------------------------- 映射

/** 租户映射（契约 §3.6 `ops.tenant_mappings`）。 */
export interface TenantMapping {
  customer: TenantCustomerRef;
  /** 客户环境标识（可选，运维自填）。 */
  externalRef?: null | string;
  id: string;
  lastKnownState?: null | string;
  lastSyncedAt?: null | string;
  mappingNo: string;
  mappingStatus: TenantMappingStatus;
  productId: string;
  /**
   * 当前同步版本，来自服务端。
   * **下发命令必须原样回传**（契约 §3.6：`expected_sync_version` 必须等于
   * `mapping.sync_version`），任何本地自增或 `0` 兜底都是缺陷。
   */
  syncVersion: number;
  /** `udone` 侧组织 ID（外部引用，不建跨 schema 外键）。 */
  udoneOrganizationId: string;
  /** 乐观锁版本，PATCH 必传。 */
  version?: number;
}

export interface TenantMappingListQuery extends TenantListQuery {
  customerId?: string;
  productId?: string;
  /** 契约 §5.7 的单值筛选（不是数组）。 */
  mappingStatus?: TenantMappingStatus;
  /**
   * 待确认：契约 §5.7 的 `GET /tenant-mappings` 未列 `syncVersion` 查询参数，
   * 但交付需求要求「按同步版本筛选」。前端按字面发送，后端未实现时应忽略而非报错。
   */
  syncVersion?: number;
}

export type TenantMappingListResult = TenantPagedResult<TenantMapping>;

/** 映射详情：`mapping{...}` + 最近 20 条命令（契约 §5.7）。 */
export interface TenantMappingDetail {
  commands: TenantCommand[];
  mapping: TenantMapping;
}

export interface CreateTenantMappingInput {
  customerId: string;
  externalRef?: string;
  productId: string;
  /** 业务原因（高风险动作必填，写入审计）。 */
  reason: string;
  udoneOrganizationId?: string;
}

export interface CreateTenantMappingResult {
  mapping: TenantMapping;
}

/**
 * 修改映射。
 *
 * 契约 §5.7：只有 `pending` 允许改外部 ID（否则 409 `STATE_CONFLICT`）；
 * `udoneOrganizationId` 已被其他客户占用时 409 `CONFLICT`
 * （`details.reason='TENANT_MAPPING_CONFLICT'`），**不自动改绑**。
 */
export interface UpdateTenantMappingInput {
  externalRef?: null | string;
  udoneOrganizationId?: string;
  /** 乐观锁版本，必传。 */
  version: number;
}

export interface UpdateTenantMappingResult {
  mapping: TenantMapping;
}

// ---------------------------------------------------------------- 命令

/** 租户命令（契约 §3.6 `ops.tenant_commands`）。 */
export interface TenantCommand {
  attemptCount: number;
  commandNo: string;
  commandType: TenantCommandType;
  completedAt?: null | string;
  contractId?: null | string;
  createdAt: string;
  customerId?: null | string;
  /** 期望同步版本：创建时由映射详情带入，服务端据此做乐观并发校验。 */
  expectedSyncVersion?: null | number;
  id: string;
  /**
   * 命令级幂等键（`UNIQUE(idempotency_key)`）。
   * 重试必须复用同一个键（契约 §2.5 双重幂等），因此详情必须能读到它。
   */
  idempotencyKey?: string;
  lastErrorCategory?: null | TenantErrorCategory;
  lastErrorCode?: null | string;
  mappingId?: null | string;
  nextRetryAt?: null | string;
  reason: string;
  requestId?: null | string;
  status: TenantCommandStatus;
  /** 乐观锁版本，重试/取消必传。 */
  version?: number;
}

/** 命令列表筛选（契约 §5.7：`status[]` 为多值）。 */
export interface TenantCommandListQuery extends TenantListQuery {
  commandType?: TenantCommandType;
  createdFrom?: string;
  createdTo?: string;
  mappingId?: string;
  status?: TenantCommandStatus[];
}

export type TenantCommandListResult = TenantPagedResult<TenantCommand>;

/** 一次执行尝试（**仅 INSERT**，审计核心，契约 §3.6）。 */
export interface TenantCommandAttempt {
  attemptNo: number;
  errorCategory?: null | TenantErrorCategory;
  finishedAt?: null | string;
  httpStatus?: null | number;
  id?: string;
  outcome: TenantAttemptOutcome;
  requestId?: null | string;
  startedAt?: null | string;
}

/** 命令详情（契约 §5.7：`command{...}` + 摘要 + `attempts[]` + `retryable`）。 */
export interface TenantCommandDetail {
  attempts: TenantCommandAttempt[];
  command: TenantCommand;
  requestSummary?: null | Record<string, unknown>;
  responseSummary?: null | Record<string, unknown>;
  /**
   * 服务端给出的可重试判定。前端还会叠加 `lastErrorCategory === 'permanent'`
   * 的本地判定（双保险：服务端字段缺失时也不能把永久错误放行）。
   */
  retryable: boolean;
}

/** 命令下发请求体（契约 §5.7）。 */
export interface CreateTenantCommandInput {
  changeRequestId?: string;
  commandType: TenantCommandType;
  contractId?: string;
  /** **必传**，取自映射详情；不允许省略或 `0` 兜底。 */
  expectedSyncVersion: number;
  payload?: TenantCommandPayload;
  reason: string;
}

export interface TenantCommandPayload {
  features?: string[];
  validFrom?: string;
  validTo?: string;
}

/**
 * 命令下发的 202 响应。
 *
 * 契约 §2.4 写 `{commandId, status, idempotencyKey}`，§5.7 写
 * `command{id,commandNo,status='pending'}` —— 两种形态都兼容，见 `normalize`。
 */
export interface TenantCommandAcceptedWire {
  command?: TenantCommand;
  commandId?: string;
  commandNo?: string;
  idempotencyKey?: string;
  status?: TenantCommandStatus;
}

/** 归一化后的受理结果：只表达「已受理」，不表达「成功」。 */
export interface TenantCommandAccepted {
  commandId: string;
  commandNo?: string;
  /** 服务端回显的幂等键；缺省时用客户端提交的键（便于继续复用）。 */
  idempotencyKey: string;
  /** 是否命中幂等重放（契约 §2.5 `Idempotent-Replay: true`）。 */
  replayed: boolean;
  status: TenantCommandStatus;
}

/** 重试（契约 §5.7）。`reason` 与 `version` 必填。 */
export interface RetryTenantCommandInput {
  reason: string;
  version: number;
}

/** 取消（契约 §5.7）。仅未发生任何尝试时可取消。 */
export interface CancelTenantCommandInput {
  reason: string;
  version: number;
}

/** 重试同样返回 202：只拿到受理结果，最终状态要再查询。 */
export interface RetryTenantCommandResult {
  accepted: TenantCommandAccepted;
  /** 服务端若在 202 体里带回完整命令则原样保留，否则由调用方刷新详情。 */
  command?: TenantCommand;
}

export interface CancelTenantCommandResult {
  command: TenantCommand;
}
