/**
 * identity 域类型。
 *
 * 契约：`Docs/ops-api-contract.md` §5.1。字段名严格照抄，不得自行改名；
 * 新增字段必须先在契约里出现。
 *
 * 注意与 `session.ts` 里 `OpsRole` 的区别：会话响应里的角色只带 `{code,name}`
 * （够渲染标签即可），角色管理端点返回完整定义。刻意不合并——合并会让会话
 * 响应被迫携带 `permissions[]`，而它已经通过 `session.permissions` 单独下发。
 */
import type { OpsOperatorStatus } from './session';

export interface OpsRoleRef {
  code: string;
  name: string;
}

/** `GET /operators` 列表项。 */
export interface OpsOperatorListItem {
  email: string;
  id: string;
  lastLoginAt: null | string;
  /**
   * MFA 策略位。契约 U-18（2026-10-30 定稿）要求列表返回它，与 `GET /session` 的
   * `operator.mfaRequired` 同源；后端实现前按可选读取，缺失时按 `false` 预填并提示。
   */
  mfaRequired?: boolean;
  roles: OpsRoleRef[];
  status: OpsOperatorStatus;
  displayName: string;
  /**
   * 乐观锁版本。契约 U-18（2026-10-30 定稿）要求列表返回它——`PATCH /operators/{operatorId}`
   * 要求 `version` 必填，而本域没有详情端点，列表是唯一取值处。
   * 后端实现前仍按可选读取：没返回就禁用编辑并说明原因，绝不伪造版本号覆盖他人改动。
   */
  version?: number;
}

/** `GET /roles` 列表项。`isSystem` 系统角色不可改 code、不可删除。 */
export interface OpsRoleDetail {
  code: string;
  /**
   * 契约 U-22（2026-10-30 定稿）要求 `GET /roles` 返回 `description`：`POST`/`PATCH` 都收它，
   * 唯独列表不返回等于「能写不能读」。后端实现前按可选读取，缺失时不渲染描述行。
   */
  description?: null | string;
  id: string;
  isSystem: boolean;
  name: string;
  /** 权限动作码，真源为契约 §4。 */
  permissions: string[];
  status: 'active' | 'disabled';
}

/** `GET /audit-events` 列表项。审计为只读事实，无任何写端点。 */
export interface OpsAuditEvent {
  id: string;
  actor: { displayName: string; id: string };
  action: string;
  entityType: string;
  entityId: string;
  reason: null | string;
  /** 变更前后摘要，形状随实体变化，界面只做原样展示与折叠。 */
  beforeSummary: null | Record<string, unknown>;
  afterSummary: null | Record<string, unknown>;
  requestId: null | string;
  createdAt: string;
}

/** `POST /operators/invitations` 请求体（契约标记幂等必填）。 */
export interface InviteOperatorPayload {
  email: string;
  roleCodes: string[];
  reason: string;
}

/** `PATCH /operators/{id}` 请求体。 */
export interface UpdateOperatorPayload {
  mfaRequired?: boolean;
  reason: string;
  roleCodes?: string[];
  status?: OpsOperatorStatus;
  /** 乐观锁版本；契约对该端点标注了 `version` 必填。 */
  version: number;
}

/** `POST /roles` 请求体。 */
export interface CreateRolePayload {
  code: string;
  description?: string;
  name: string;
  permissionCodes: string[];
}

/** `PATCH /roles/{id}` 请求体。 */
export interface UpdateRolePayload {
  description?: string;
  name?: string;
  permissionCodes?: string[];
  reason: string;
  status?: 'active' | 'disabled';
}

export interface OperatorListQuery {
  keyword?: string;
  page?: number;
  pageSize?: number;
  roleCode?: string;
  status?: OpsOperatorStatus;
}

export interface AuditEventListQuery {
  action?: string;
  actorOperatorId?: string;
  entityId?: string;
  entityType?: string;
  from?: string;
  page?: number;
  pageSize?: number;
  requestId?: string;
  to?: string;
}

export interface OpsPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** 行为主体引用（`actor` / `createdBy` 这类字段的通用形态）。 */
export interface OpsActorRef {
  displayName: string;
  id: string;
}

/**
 * 契约只写 `requestedBy` / `updatedBy`，没有给形状（表列是 `requested_by uuid`）。
 * 前端两种形态都接受：字符串按 id 显示，对象取 `displayName ?? id`。
 * 不在这里替后端选形态——写成一种会在联调时把另一种静默渲染成 `[object Object]`。
 */
export type OpsActorLike = OpsActorRef | string;

/* ------------------------------------------------------------------ *
 * 运营总览（契约 §5.9 `GET /overview`）
 * ------------------------------------------------------------------ */

/** 总览指标。金额类字段同契约 §2.2：`number`、最多 2 位小数。 */
export interface OpsOverviewMetrics {
  activeCustomers: number;
  activeContracts: number;
  runningTenants: number;
  activeEntitlements: number;
  expiringEntitlements: number;
  openTickets: number;
  waitingTickets: number;
  failedSyncCommands: number;
  pendingReceiptAmount: number;
  unreconciledAmount: number;
}

/** 按币种分组，不跨币种合并（契约 §2.2 / U-12）。 */
export interface OpsOverviewAmount {
  currency: string;
  totalReceivable: number;
  settledReceivable: number;
  overdueReceivable: number;
  upcomingReceivable: number;
}

/**
 * 部分指标取数失败。
 *
 * 契约 §5.9 只声明了 `partialFailures[]` 这个数组名，**没有定义条目字段**。
 * 这里按「宽松读取」处理：字段全部可选，界面把未识别的键原样列出。
 * 这样后端定稿前不会因为多一个/少一个字段而渲染成空白，也不会让前端
 * 假装自己知道契约里没有的东西。
 */
export interface OpsOverviewPartialFailure {
  code?: string;
  message?: string;
  section?: string;
}

export interface OpsOverview {
  statisticsAt: string;
  windowDays: number;
  metrics: OpsOverviewMetrics;
  amounts: OpsOverviewAmount[];
  partialFailures: OpsOverviewPartialFailure[];
}

/* ------------------------------------------------------------------ *
 * 系统设置与字典（契约 §5.9 `/settings`、`/dictionaries`）
 * ------------------------------------------------------------------ */

/** 三项可配置值，`key` 白名单见契约 §3.9 `ops.settings`。 */
export interface OpsSettings {
  /** `overview.expiryWindowDays`：临期权益窗口，1–365 天 */
  overviewExpiryWindowDays: number;
  /** `ticket.dueHours`：工单内部时限，1–720 小时 */
  ticketDueHours: number;
  /** `retention.exportDays`：导出产物保留天数 */
  exportRetentionDays: number;
}

export interface OpsSettingsResponse {
  settings: OpsSettings;
  updatedAt: null | string;
  updatedBy: null | OpsActorLike;
}

/** `PATCH /settings`：只发被改动的项，`reason` 必填（设置变更写审计）。 */
export interface UpdateSettingsPayload {
  exportRetentionDays?: number;
  overviewExpiryWindowDays?: number;
  reason: string;
  ticketDueHours?: number;
}

export interface OpsDictionaryItem {
  /**
   * 契约 U-19（2026-10-30 定稿）要求条目返回 `id`：`PATCH /dictionary-items/{itemId}` 按它寻址，
   * 原文只列了 `{value,label,sortOrder,isActive}`，端点因此不可用。
   * 后端实现前按可选读取，缺失时该行只读并说明原因。
   */
  id?: string;
  isActive: boolean;
  label: string;
  sortOrder: number;
  value: string;
}

export interface OpsDictionary {
  code: string;
  items: OpsDictionaryItem[];
  name: string;
}

export interface OpsDictionaryList {
  items: OpsDictionary[];
}

export interface CreateDictionaryItemPayload {
  label: string;
  sortOrder?: number;
  value: string;
}

export interface UpdateDictionaryItemPayload {
  isActive?: boolean;
  label?: string;
  sortOrder?: number;
}

/* ------------------------------------------------------------------ *
 * 导出任务（契约 §5.9 `/exports`）
 * ------------------------------------------------------------------ */

export type OpsExportStatus =
  | 'expired'
  | 'failed'
  | 'queued'
  | 'running'
  | 'succeeded';

export type OpsExportType =
  | 'contracts'
  | 'customers'
  | 'receipts'
  | 'receivables'
  | 'tickets';

export interface OpsExportTask {
  completedAt?: null | string;
  createdAt: string;
  /**
   * 签名下载地址，仅 `GET /exports/{exportId}` 返回，有效期 ≤ 5 分钟（契约 §5.9）。
   * 因此**不能**缓存到列表里复用：列表项没有该字段，详情要现取。
   */
  downloadUrl?: string;
  expiresAt: null | string;
  exportNo: string;
  exportType: string;
  id: string;
  requestedBy: null | OpsActorLike;
  rowCount: null | number;
  status: string;
}

export interface OpsExportListQuery {
  exportType?: OpsExportType;
  page?: number;
  pageSize?: number;
  requestedBy?: string;
  status?: OpsExportStatus[];
}

/**
 * `POST /exports` 请求体。
 *
 * `reason` 是**前端推导项**：契约 §5.9 只列了 `exportType` / `filters`，但 §4 把
 * `export.create` 标为高风险动作并要求填写原因。前端收集后随请求体提交，
 * 已登记为推导项 U-17 等后端确认；后端若不接受该字段，多余字段应被忽略而不是报错。
 */
export interface CreateExportPayload {
  exportType: OpsExportType;
  filters: Record<string, unknown>;
  reason: string;
}

export interface CreateExportResult {
  exportNo: string;
  id: string;
  status: 'queued';
}
