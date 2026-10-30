/**
 * identity-audit 域开发态契约桩（仅 `VITE_OPS_MOCK=true` 的非生产构建里动态加载）。
 *
 * 目的：后端 ops identity/overview/settings/exports 端点尚未交付时，页面仍能走通
 * 全部状态（loading / empty / error / validation / permission / conflict / 高风险确认），
 * 且**不冒充真实集成**——页面同时展示「开发态数据」提示。
 *
 * 桩刻意复刻服务端不变量，否则前端会在假的成功里漏掉真实错误分支：
 * - 成员乐观锁版本不匹配 → 409 `CONFLICT`（他人已改，前端必须刷新）；
 * - 移除成员最后一个角色 → 409 `STATE_CONFLICT` + `reason='LAST_ROLE'`；
 * - 移除/停用最后一个具备 `operator.manage` 的账号 → `reason='LAST_ADMIN'`；
 * - 邀请已存在的邮箱 → 409 `CONFLICT`；
 * - 角色 code 重复 → 409 `CONFLICT`；系统角色不可改 code；
 * - 设置越界（窗口 1–365、工时 1–720）→ 400 `VALIDATION_ERROR` + `details.issues`；
 * - 字典项 `value` 重复 → 409 `CONFLICT`；
 * - 导出为异步：`POST` 只返回 `queued`，**不谎报成功**；状态在后续读取时推进一次。
 *
 * 桩**不读本机时钟**：时间一律从夹具基准（2026-10-30T00:00:00Z）偏移，
 * 每次写操作推进 1 分钟，保证新事件排在历史之后且断言可复现。
 */
import type { StubOperatorRow } from './fixtures';
import type { OpsOperatorStatus } from './session';
import type {
  AuditEventListQuery,
  CreateDictionaryItemPayload,
  CreateExportPayload,
  CreateExportResult,
  CreateRolePayload,
  InviteOperatorPayload,
  OperatorListQuery,
  OpsAuditEvent,
  OpsDictionary,
  OpsDictionaryItem,
  OpsExportListQuery,
  OpsExportTask,
  OpsOverview,
  OpsPage,
  OpsRoleDetail,
  OpsRoleRef,
  OpsSettings,
  OpsSettingsResponse,
  UpdateDictionaryItemPayload,
  UpdateOperatorPayload,
  UpdateRolePayload,
  UpdateSettingsPayload,
} from './types';

import { OpsApiError, resolveUserMessage } from '#/api/adapter/errors';

import {
  STUB_AUDIT_EVENTS,
  STUB_CURRENT_OPERATOR_ID,
  STUB_DICTIONARIES,
  STUB_EXPORT_TASKS,
  STUB_NOW,
  STUB_OPERATOR_ROWS,
  STUB_OVERVIEW,
  STUB_ROLES,
  STUB_SETTINGS,
  STUB_SETTINGS_META,
} from './fixtures';

const STUB_LATENCY_MS = 100;
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_WHITELIST = new Set([10, 15, 20, 30, 50, 100]);
const DAY_MS = 86_400_000;

interface StubState {
  auditEvents: OpsAuditEvent[];
  dictionaries: OpsDictionary[];
  exportProgress: Map<string, number>;
  exports: OpsExportTask[];
  operators: StubOperatorRow[];
  roles: OpsRoleDetail[];
  sequence: number;
  settings: OpsSettings;
  settingsMeta: {
    updatedAt: null | string;
    updatedBy: null | { displayName: string; id: string };
  };
  /** 每次写操作推进 1 分钟，保证新记录排在历史之后（不依赖本机时钟）。 */
  tick: number;
}

function cloneState(): StubState {
  return {
    auditEvents: STUB_AUDIT_EVENTS.map((event) => ({
      ...event,
      afterSummary: event.afterSummary ? { ...event.afterSummary } : null,
      beforeSummary: event.beforeSummary ? { ...event.beforeSummary } : null,
      actor: { ...event.actor },
    })),
    dictionaries: STUB_DICTIONARIES.map((dictionary) => ({
      ...dictionary,
      items: dictionary.items.map((item) => ({ ...item })),
    })),
    exportProgress: new Map(),
    exports: STUB_EXPORT_TASKS.map((task) => ({ ...task })),
    operators: STUB_OPERATOR_ROWS.map((row) => ({
      ...row,
      roleCodes: [...row.roleCodes],
    })),
    roles: STUB_ROLES.map((role) => ({
      ...role,
      permissions: [...role.permissions],
    })),
    sequence: 500,
    settings: { ...STUB_SETTINGS },
    settingsMeta: {
      updatedAt: STUB_SETTINGS_META.updatedAt,
      updatedBy: { ...STUB_SETTINGS_META.updatedBy },
    },
    tick: 0,
  };
}

let state: StubState = cloneState();

/** 仅供单测重置桩状态。 */
export function resetStubIdentityState(): void {
  state = cloneState();
}

function nextTime(offsetMs = 0): string {
  state.tick += 1;
  return new Date(
    Date.parse(STUB_NOW) + state.tick * 60_000 + offsetMs,
  ).toISOString();
}

function nextSequence(): number {
  state.sequence += 1;
  return state.sequence;
}

function uuidFrom(sequence: number, prefix: string): string {
  return `${prefix}-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function respond<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), STUB_LATENCY_MS);
  });
}

function fail(options: {
  code: string;
  details?: Record<string, unknown>;
  reason?: string;
  status: number;
}): never {
  throw new OpsApiError({
    code: options.code,
    details: options.details,
    kind: 'http',
    reason: options.reason,
    requestId: 'stub-request',
    retryable: false,
    status: options.status,
    userMessage: resolveUserMessage(options.code, options.reason),
  });
}

function paginate<T>(
  items: T[],
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
): OpsPage<T> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.trunc(page) : 1;
  const safeSize = PAGE_SIZE_WHITELIST.has(Number(pageSize))
    ? Number(pageSize)
    : DEFAULT_PAGE_SIZE;
  const start = (safePage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    page: safePage,
    pageSize: safeSize,
    total: items.length,
  };
}

/* ------------------------------------------------------------------ *
 * 审计（所有写操作都会追加一条，与后端「动作发生时落库」一致）
 * ------------------------------------------------------------------ */

function appendAudit(input: {
  action: string;
  after: null | Record<string, unknown>;
  before: null | Record<string, unknown>;
  entityId: string;
  entityType: string;
  reason: null | string;
}): OpsAuditEvent {
  const sequence = nextSequence();
  const event: OpsAuditEvent = {
    action: input.action,
    actor: {
      displayName: '平台管理员·陈（虚构）',
      id: STUB_CURRENT_OPERATOR_ID,
    },
    afterSummary: input.after,
    beforeSummary: input.before,
    createdAt: nextTime(),
    entityId: input.entityId,
    entityType: input.entityType,
    id: `audit-stub-${sequence}`,
    reason: input.reason,
    requestId: `req-stub-${sequence}`,
  };
  state.auditEvents.push(event);
  return event;
}

export async function stubListAuditEvents(
  query: AuditEventListQuery = {},
): Promise<OpsPage<OpsAuditEvent>> {
  const rows = state.auditEvents
    .filter((event) => {
      if (query.action && event.action !== query.action) {
        return false;
      }
      if (query.actorOperatorId && event.actor.id !== query.actorOperatorId) {
        return false;
      }
      if (query.entityType && event.entityType !== query.entityType) {
        return false;
      }
      if (query.entityId && event.entityId !== query.entityId) {
        return false;
      }
      if (query.requestId && event.requestId !== query.requestId) {
        return false;
      }
      if (query.from && event.createdAt < query.from) {
        return false;
      }
      if (query.to && event.createdAt > query.to) {
        return false;
      }
      return true;
    })
    // 审计按时间倒序：最近发生的排最前，且不接受前端自定义排序。
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  return respond(paginate(rows, query.page, query.pageSize));
}

/* ------------------------------------------------------------------ *
 * 成员与角色
 * ------------------------------------------------------------------ */

function roleRefsOf(roleCodes: readonly string[]): OpsRoleRef[] {
  return roleCodes.flatMap((code) => {
    const role = state.roles.find((item) => item.code === code);
    return role ? [{ code: role.code, name: role.name }] : [];
  });
}

function permissionsOfRoles(roleCodes: readonly string[]): Set<string> {
  const permissions = new Set<string>();
  for (const code of roleCodes) {
    const role = state.roles.find((item) => item.code === code);
    if (!role) {
      continue;
    }
    for (const permission of role.permissions) {
      permissions.add(permission);
    }
  }
  return permissions;
}

function toOperatorItem(row: StubOperatorRow) {
  return {
    displayName: row.displayName,
    email: row.email,
    id: row.id,
    lastLoginAt: row.lastLoginAt,
    mfaRequired: row.mfaRequired,
    roles: roleRefsOf(row.roleCodes),
    status: row.status,
    version: row.version,
  };
}

function operatorRowById(operatorId: string): StubOperatorRow {
  const row = state.operators.find((item) => item.id === operatorId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

/** 除 `excludedId` 外，是否还有启用中的账号具备给定动作码。 */
function hasOtherActiveHolder(permission: string, excludedId: string): boolean {
  return state.operators.some(
    (row) =>
      row.id !== excludedId &&
      row.status === 'active' &&
      permissionsOfRoles(row.roleCodes).has(permission),
  );
}

export async function stubListOperators(
  query: OperatorListQuery = {},
): Promise<OpsPage<ReturnType<typeof toOperatorItem>>> {
  const keyword = (query.keyword ?? '').trim().toLowerCase();
  const rows = state.operators.filter((row) => {
    if (query.status && row.status !== query.status) {
      return false;
    }
    if (query.roleCode && !row.roleCodes.includes(query.roleCode)) {
      return false;
    }
    if (keyword !== '') {
      const haystack = `${row.email} ${row.displayName}`.toLowerCase();
      if (!haystack.includes(keyword)) {
        return false;
      }
    }
    return true;
  });
  const page = paginate(rows, query.page, query.pageSize);
  return respond({
    ...page,
    items: page.items.map((row) => toOperatorItem(row)),
  });
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function stubInviteOperator(
  payload: InviteOperatorPayload,
): Promise<{
  invitationExpiresAt: string;
  operator: { id: string; status: 'invited' };
}> {
  const email = payload.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  if (payload.reason.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  if (payload.roleCodes.length === 0) {
    fail({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_ROLE' },
      reason: 'LAST_ROLE',
      status: 409,
    });
  }
  if (state.operators.some((row) => row.email.toLowerCase() === email)) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  for (const code of payload.roleCodes) {
    if (!state.roles.some((role) => role.code === code)) {
      fail({ code: 'VALIDATION_ERROR', status: 400 });
    }
  }

  const sequence = nextSequence();
  const row: StubOperatorRow = {
    displayName: email.split('@')[0] ?? email,
    email,
    id: uuidFrom(sequence, '00000000'),
    lastLoginAt: null,
    mfaRequired: false,
    roleCodes: [...payload.roleCodes],
    status: 'invited',
    version: 1,
  };
  state.operators.push(row);
  appendAudit({
    action: 'operator.invite',
    after: { email, roleCodes: [...payload.roleCodes] },
    before: null,
    entityId: row.id,
    entityType: 'operator',
    reason: payload.reason.trim(),
  });

  return respond({
    invitationExpiresAt: nextTime(7 * DAY_MS),
    operator: { id: row.id, status: 'invited' as const },
  });
}

export async function stubUpdateOperator(
  operatorId: string,
  payload: UpdateOperatorPayload,
): Promise<{
  operator: ReturnType<typeof toOperatorItem>;
  permissionsChanged: { added: string[]; removed: string[] };
}> {
  const row = operatorRowById(operatorId);
  if (payload.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  if (payload.reason.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }

  const nextRoleCodes = payload.roleCodes ?? row.roleCodes;
  if (nextRoleCodes.length === 0) {
    fail({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_ROLE' },
      reason: 'LAST_ROLE',
      status: 409,
    });
  }
  for (const code of nextRoleCodes) {
    if (!state.roles.some((role) => role.code === code)) {
      fail({ code: 'VALIDATION_ERROR', status: 400 });
    }
  }

  const nextStatus: OpsOperatorStatus = payload.status ?? row.status;
  const beforePermissions = permissionsOfRoles(row.roleCodes);
  const afterPermissions = permissionsOfRoles(nextRoleCodes);

  // 最后一个管理员：改角色或停用都可能让系统没人能管账号，服务端会拒绝。
  const losesManage =
    beforePermissions.has('operator.manage') &&
    (!afterPermissions.has('operator.manage') || nextStatus !== 'active');
  if (losesManage && !hasOtherActiveHolder('operator.manage', row.id)) {
    fail({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_ADMIN' },
      reason: 'LAST_ADMIN',
      status: 409,
    });
  }

  const before = {
    mfaRequired: row.mfaRequired,
    roleCodes: [...row.roleCodes],
    status: row.status,
  };
  row.roleCodes = [...nextRoleCodes];
  row.status = nextStatus;
  if (payload.mfaRequired !== undefined) {
    row.mfaRequired = payload.mfaRequired;
  }
  row.version += 1;

  appendAudit({
    action:
      payload.roleCodes !== undefined && payload.status === undefined
        ? 'operator.roles_changed'
        : 'operator.status_changed',
    after: {
      mfaRequired: row.mfaRequired,
      roleCodes: [...row.roleCodes],
      status: row.status,
    },
    before,
    entityId: row.id,
    entityType: 'operator',
    reason: payload.reason.trim(),
  });

  const added = [...afterPermissions].filter(
    (permission) => !beforePermissions.has(permission),
  );
  const removed = [...beforePermissions].filter(
    (permission) => !afterPermissions.has(permission),
  );

  return respond({
    operator: toOperatorItem(row),
    permissionsChanged: { added, removed },
  });
}

export async function stubListRoles(): Promise<OpsPage<OpsRoleDetail>> {
  const items = state.roles.map((role) => ({
    ...role,
    permissions: [...role.permissions],
  }));
  return respond({
    items,
    page: 1,
    pageSize: items.length,
    total: items.length,
  });
}

export async function stubCreateRole(
  payload: CreateRolePayload,
): Promise<OpsRoleDetail> {
  const code = payload.code.trim();
  if (code === '' || payload.name.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  if (state.roles.some((role) => role.code === code)) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  const sequence = nextSequence();
  const role: OpsRoleDetail = {
    code,
    description: payload.description ?? null,
    id: uuidFrom(sequence, '00000000'),
    isSystem: false,
    name: payload.name.trim(),
    permissions: [...payload.permissionCodes],
    status: 'active',
  };
  state.roles.push(role);
  appendAudit({
    action: 'role.create',
    after: { code, permissions: [...role.permissions] },
    before: null,
    entityId: role.id,
    entityType: 'role',
    reason: null,
  });
  return respond({ ...role, permissions: [...role.permissions] });
}

export async function stubUpdateRole(
  roleId: string,
  payload: UpdateRolePayload,
): Promise<{
  afterPermissions: string[];
  beforePermissions: string[];
  role: OpsRoleDetail;
}> {
  const role = state.roles.find((item) => item.id === roleId);
  if (!role) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  if (payload.reason.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  const beforePermissions = [...role.permissions];
  if (payload.name !== undefined) {
    role.name = payload.name;
  }
  if (payload.description !== undefined) {
    role.description = payload.description;
  }
  if (payload.permissionCodes !== undefined) {
    role.permissions = [...payload.permissionCodes];
  }
  if (payload.status !== undefined) {
    role.status = payload.status;
  }
  appendAudit({
    action: 'role.permissions_changed',
    after: { permissions: [...role.permissions], roleCode: role.code },
    before: { permissions: beforePermissions, roleCode: role.code },
    entityId: role.id,
    entityType: 'role',
    reason: payload.reason.trim(),
  });
  return respond({
    afterPermissions: [...role.permissions],
    beforePermissions,
    role: { ...role, permissions: [...role.permissions] },
  });
}

/* ------------------------------------------------------------------ *
 * 总览 / 设置 / 字典
 * ------------------------------------------------------------------ */

export async function stubOverview(query: {
  windowDays?: number;
}): Promise<OpsOverview> {
  const windowDays =
    query.windowDays ?? state.settings.overviewExpiryWindowDays;
  if (windowDays < 1 || windowDays > 365) {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  // 统计时刻用桩内部推进后的时间，保证「刷新后统计时刻会变」，与真实服务端一致。
  return respond({
    ...STUB_OVERVIEW,
    amounts: STUB_OVERVIEW.amounts.map((amount) => ({ ...amount })),
    metrics: { ...STUB_OVERVIEW.metrics },
    partialFailures: STUB_OVERVIEW.partialFailures.map((item) => ({ ...item })),
    statisticsAt: nextTime(),
    windowDays,
  });
}

export async function stubGetSettings(): Promise<OpsSettingsResponse> {
  return respond({
    settings: { ...state.settings },
    updatedAt: state.settingsMeta.updatedAt,
    updatedBy: state.settingsMeta.updatedBy,
  });
}

const SETTINGS_RANGE: Record<
  keyof OpsSettings,
  { label: string; max: null | number; min: number }
> = {
  exportRetentionDays: { label: '导出产物保留天数', max: null, min: 1 },
  overviewExpiryWindowDays: { label: '临期权益窗口', max: 365, min: 1 },
  ticketDueHours: { label: '工单内部时限', max: 720, min: 1 },
};

export async function stubUpdateSettings(
  payload: UpdateSettingsPayload,
): Promise<{ settings: OpsSettings }> {
  if (payload.reason.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  const issues: { code: string; message: string; path: string }[] = [];
  const next: OpsSettings = { ...state.settings };
  for (const key of Object.keys(SETTINGS_RANGE) as (keyof OpsSettings)[]) {
    const value = payload[key];
    if (value === undefined) {
      continue;
    }
    const range = SETTINGS_RANGE[key];
    if (
      !Number.isInteger(value) ||
      value < range.min ||
      (range.max !== null && value > range.max)
    ) {
      issues.push({
        code: 'OUT_OF_RANGE',
        message: `${range.label}超出允许范围`,
        path: key,
      });
      continue;
    }
    next[key] = value;
  }
  if (issues.length > 0) {
    fail({
      code: 'VALIDATION_ERROR',
      details: { issues },
      status: 400,
    });
  }

  const before = { ...state.settings };
  state.settings = next;
  state.settingsMeta = {
    updatedAt: nextTime(),
    updatedBy: {
      displayName: '平台管理员·陈（虚构）',
      id: STUB_CURRENT_OPERATOR_ID,
    },
  };
  appendAudit({
    action: 'settings.update',
    after: { ...next },
    before,
    entityId: '',
    entityType: 'settings',
    reason: payload.reason.trim(),
  });
  return respond({ settings: { ...next } });
}

export async function stubListDictionaries(): Promise<{
  items: OpsDictionary[];
}> {
  return respond({
    items: state.dictionaries.map((dictionary) => ({
      ...dictionary,
      items: dictionary.items.map((item) => ({ ...item })),
    })),
  });
}

function dictionaryOf(code: string): OpsDictionary {
  const dictionary = state.dictionaries.find((item) => item.code === code);
  if (!dictionary) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return dictionary;
}

export async function stubCreateDictionaryItem(
  dictionaryCode: string,
  payload: CreateDictionaryItemPayload,
): Promise<{ item: OpsDictionaryItem }> {
  const dictionary = dictionaryOf(dictionaryCode);
  const value = payload.value.trim();
  const label = payload.label.trim();
  if (value === '' || label === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  // 停用项也占位：value 是单据上的历史取值，重复会让回显无法区分。
  if (dictionary.items.some((item) => item.value === value)) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  const item: OpsDictionaryItem = {
    id: `dict-item-stub-${nextSequence()}`,
    isActive: true,
    label,
    sortOrder: payload.sortOrder ?? dictionary.items.length + 1,
    value,
  };
  dictionary.items.push(item);
  appendAudit({
    action: 'dictionary_item.create',
    after: { code: dictionary.code, label, value },
    before: null,
    entityId: item.id ?? '',
    entityType: 'dictionary_item',
    reason: null,
  });
  return respond({ item: { ...item } });
}

export async function stubUpdateDictionaryItem(
  itemId: string,
  payload: UpdateDictionaryItemPayload,
): Promise<{ item: OpsDictionaryItem }> {
  const dictionary = state.dictionaries.find((entry) =>
    entry.items.some((item) => item.id === itemId),
  );
  const item = dictionary?.items.find((entry) => entry.id === itemId);
  if (!dictionary || !item) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  const before = { ...item };
  if (payload.label !== undefined) {
    item.label = payload.label;
  }
  if (payload.sortOrder !== undefined) {
    item.sortOrder = payload.sortOrder;
  }
  if (payload.isActive !== undefined) {
    item.isActive = payload.isActive;
  }
  appendAudit({
    action: 'dictionary_item.update',
    after: { ...item },
    before,
    entityId: itemId,
    entityType: 'dictionary_item',
    reason: null,
  });
  return respond({ item: { ...item } });
}

/* ------------------------------------------------------------------ *
 * 导出任务（异步：创建只入队，状态在后续读取时推进）
 * ------------------------------------------------------------------ */

/**
 * 推进一次导出任务状态：`queued` → `running` → `succeeded`。
 *
 * 为什么要「读取时推进」：真实后端由后台任务推进，前端只能轮询观察。
 * 桩若在创建时就返回 `succeeded`，页面上的「排队中 → 生成中 → 已完成」
 * 三条分支永远不会被走到，等于把最需要验证的异步态漏掉。
 */
function advanceExports(): void {
  for (const task of state.exports) {
    if (task.status !== 'queued' && task.status !== 'running') {
      continue;
    }
    const progress = (state.exportProgress.get(task.id) ?? 0) + 1;
    state.exportProgress.set(task.id, progress);
    if (task.status === 'queued') {
      task.status = 'running';
      continue;
    }
    if (task.status === 'running' && progress >= 2) {
      task.status = 'succeeded';
      task.completedAt = nextTime();
      task.rowCount = 1200 + progress;
      task.expiresAt = new Date(
        Date.parse(task.completedAt) +
          state.settings.exportRetentionDays * DAY_MS,
      ).toISOString();
    }
  }
}

export async function stubListExportTasks(
  query: OpsExportListQuery = {},
): Promise<OpsPage<OpsExportTask>> {
  advanceExports();
  const rows = state.exports
    .filter((task) => {
      if (query.exportType && task.exportType !== query.exportType) {
        return false;
      }
      if (query.status && query.status.length > 0) {
        const wanted: string[] = [...query.status];
        if (!wanted.includes(task.status)) {
          return false;
        }
      }
      if (query.requestedBy) {
        const requester =
          typeof task.requestedBy === 'string'
            ? task.requestedBy
            : task.requestedBy?.id;
        if (requester !== query.requestedBy) {
          return false;
        }
      }
      return true;
    })
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  return respond(paginate(rows, query.page, query.pageSize));
}

export async function stubCreateExport(
  payload: CreateExportPayload,
): Promise<CreateExportResult> {
  const allowed = new Set([
    'contracts',
    'customers',
    'receipts',
    'receivables',
    'tickets',
  ]);
  if (!allowed.has(payload.exportType)) {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  if (payload.reason.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  const sequence = nextSequence();
  const task: OpsExportTask = {
    completedAt: null,
    createdAt: nextTime(),
    expiresAt: null,
    exportNo: `EX-2026-${String(sequence).padStart(6, '0')}`,
    exportType: payload.exportType,
    id: uuidFrom(sequence, '00000000'),
    requestedBy: {
      displayName: '平台管理员·陈（虚构）',
      id: STUB_CURRENT_OPERATOR_ID,
    },
    rowCount: null,
    status: 'queued',
  };
  state.exports.push(task);
  appendAudit({
    action: 'export.create',
    after: { exportNo: task.exportNo, exportType: task.exportType },
    before: null,
    entityId: task.id,
    entityType: 'export',
    reason: payload.reason.trim(),
  });
  // 202 语义：只表示「已入队」，不代表导出成功。
  return respond({
    exportNo: task.exportNo,
    id: task.id,
    status: 'queued' as const,
  });
}

export async function stubGetExportTask(
  exportId: string,
): Promise<OpsExportTask> {
  advanceExports();
  const task = state.exports.find((item) => item.id === exportId);
  if (!task) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  if (task.status !== 'succeeded') {
    return respond({ ...task });
  }
  // 签名 URL 有效期 ≤ 5 分钟（契约 §5.9），桩里标注 5 分钟过期时间，绝不长期有效。
  return respond({
    ...task,
    downloadUrl: `https://exports.example.invalid/${task.exportNo}.csv?signature=stub&expires=${encodeURIComponent(
      stubTimePlusMinutes(5),
    )}`,
  });
}

function stubTimePlusMinutes(minutes: number): string {
  return new Date(Date.parse(STUB_NOW) + minutes * 60_000).toISOString();
}
