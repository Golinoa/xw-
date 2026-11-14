import type { StubInstanceRow } from './fixtures';
/**
 * 开发态部署契约桩（仅在 `VITE_OPS_MOCK=true` 的非生产构建里被动态加载）。
 *
 * 目的：在 `udone` 的 ops deployment API 尚未交付时，页面可以走通全部状态
 * （loading / empty / error / validation / permission / conflict / 破坏性确认），
 * 且**不冒充真实集成**——页面同时展示「开发态数据」提示。
 *
 * 桩刻意复刻服务端不变量，否则前端会在假的成功里漏掉真实错误分支：
 * - 同客户同名实例 → 409 `CONFLICT`（契约 §3.7 `UNIQUE(customer_id, name)`）；
 * - `version` 不匹配 → 409 `CONFLICT`（前端必须刷新，不得本地覆盖）；
 * - 非法状态迁移 → 409 `STATE_CONFLICT`（契约 §3.7 状态机）；
 * - `retire` 缺原因 → 400 `VALIDATION_ERROR`；
 * - `go_live` 缺 `go_live_on` → 409 `STATE_CONFLICT`（契约要求上线日期）；
 * - 升级登记 `fromVersion` ≠ 当前版本 → 409 `STATE_CONFLICT` + `VERSION_MISMATCH`；
 * - 升级记录**只追加**：登记后 push 新行，旧行一字不改。
 *
 * 桩**不执行**任何远程动作：没有安装、没有升级脚本、没有环境凭据。
 */
import type {
  CreateDeploymentInput,
  CreateDeploymentResult,
  CreateVersionRecordInput,
  CreateVersionRecordResult,
  DeploymentDetail,
  DeploymentInstance,
  DeploymentInstanceStatus,
  DeploymentListQuery,
  DeploymentListResult,
  DeploymentTransitionAction,
  DeploymentTransitionInput,
  DeploymentTransitionResult,
  DeploymentVersionRecord,
  UpdateDeploymentInput,
  UpdateDeploymentResult,
  VersionRecordListResult,
} from './types';

import { OpsApiError, resolveUserMessage } from '#/api/adapter/errors';

import {
  STUB_CURRENT_OPERATOR_ID,
  STUB_CUSTOMERS,
  STUB_INSTANCES,
  STUB_LICENSES,
  STUB_OPERATORS,
  STUB_PRODUCTS,
  STUB_VERSION_RECORDS,
} from './fixtures';

const STUB_LATENCY_MS = 120;
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_WHITELIST = new Set([10, 15, 20, 30, 50, 100]);

interface StubState {
  instances: StubInstanceRow[];
  sequence: number;
  versionRecords: DeploymentVersionRecord[];
}

function cloneState(): StubState {
  return {
    instances: STUB_INSTANCES.map((row) => ({ ...row })),
    sequence: 900,
    versionRecords: STUB_VERSION_RECORDS.map((row) => ({ ...row })),
  };
}

let state: StubState = cloneState();

/** 仅供单测重置桩状态。 */
export function resetStubDeploymentState(): void {
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

function customerRef(customerId: string) {
  const customer =
    Object.values(STUB_CUSTOMERS).find((item) => item.id === customerId) ??
    STUB_CUSTOMERS.c1;
  return {
    customerNo: customer.customerNo,
    id: customer.id,
    name: customer.name,
  };
}

function ownerRef(id: null | string | undefined) {
  if (!id) {
    return null;
  }
  const found = Object.values(STUB_OPERATORS).find((item) => item.id === id);
  return found ? { displayName: found.displayName, id: found.id } : { id };
}

function toInstance(row: StubInstanceRow): DeploymentInstance {
  return {
    contractId: row.contractId,
    currentVersion: row.currentVersion,
    customer: customerRef(row.customerId),
    deploymentType: row.deploymentType,
    environmentRef: row.environmentRef,
    goLiveOn: row.goLiveOn,
    id: row.id,
    instanceNo: row.instanceNo,
    lastVersionRecordAt: row.lastVersionRecordAt,
    licenseId: row.licenseId,
    maintenanceUntil: row.maintenanceUntil,
    name: row.name,
    owner: ownerRef(row.ownerOperatorId),
    status: row.status,
    version: row.version,
  };
}

function instanceRowById(deploymentId: string): StubInstanceRow {
  const row = state.instances.find((item) => item.id === deploymentId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

/** 版本号的「相等」只按字符串比较：不透明版本号，不做语义大小判断。 */
function sameVersion(
  left: null | string | undefined,
  right: null | string | undefined,
): boolean {
  return (left ?? '').trim() === (right ?? '').trim();
}

export async function stubListDeployments(
  query: DeploymentListQuery = {},
): Promise<DeploymentListResult> {
  let rows = [...state.instances];
  if (query.customerId) {
    rows = rows.filter((row) => row.customerId === query.customerId);
  }
  if (query.productId) {
    rows = rows.filter((row) => row.productId === query.productId);
  }
  if (query.deploymentType) {
    rows = rows.filter((row) => row.deploymentType === query.deploymentType);
  }
  if (query.currentVersion) {
    rows = rows.filter((row) =>
      sameVersion(row.currentVersion, query.currentVersion),
    );
  }
  if (query.maintenanceUntilBefore) {
    const bound = query.maintenanceUntilBefore;
    rows = rows.filter(
      (row) =>
        row.maintenanceUntil !== null &&
        row.maintenanceUntil !== '' &&
        row.maintenanceUntil <= bound,
    );
  }
  if (query.status && query.status.length > 0) {
    const allowed = new Set<string>(query.status);
    rows = rows.filter((row) => allowed.has(row.status));
  }
  const direction = query.order === 'asc' ? 1 : -1;
  rows = rows.toSorted((left, right) => {
    if (left.instanceNo === right.instanceNo) {
      return 0;
    }
    return left.instanceNo < right.instanceNo ? direction : -direction;
  });
  return respond(
    paginate(
      rows.map((row) => toInstance(row)),
      query.page,
      query.pageSize,
    ),
  );
}

export async function stubGetDeployment(
  deploymentId: string,
): Promise<DeploymentDetail> {
  const row = instanceRowById(deploymentId);
  const license = STUB_LICENSES[row.id];
  return respond({
    deployment: toInstance(row),
    licenses: license ? [{ ...license }] : [],
    tickets: [],
    versionRecords: state.versionRecords
      .filter((item) => item.instanceId === row.id)
      .toSorted((left, right) => (left.executedOn < right.executedOn ? 1 : -1))
      .map((item) => ({ ...item })),
  });
}

export async function stubCreateDeployment(
  input: CreateDeploymentInput,
): Promise<CreateDeploymentResult> {
  if (input.name.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', message: '请填写实例名称', status: 400 });
  }
  if (!input.customerId) {
    fail({ code: 'VALIDATION_ERROR', message: '请选择客户', status: 400 });
  }
  if (!input.deploymentType) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '请选择部署类型（private / dedicated）',
      status: 400,
    });
  }
  const duplicated = state.instances.some(
    (row) =>
      row.customerId === input.customerId &&
      row.name.trim() === input.name.trim(),
  );
  if (duplicated) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  state.sequence += 1;
  const row: StubInstanceRow = {
    contractId: null,
    currentVersion: input.currentVersion?.trim() || null,
    customerId: input.customerId,
    deploymentType: input.deploymentType,
    environmentRef: input.environmentRef?.trim() || null,
    goLiveOn: input.goLiveOn ?? null,
    id: `66666666-6666-4666-8666-${String(state.sequence).padStart(12, '0')}`,
    instanceNo: `DP-2026-${String(state.sequence).padStart(6, '0')}`,
    lastVersionRecordAt: null,
    licenseId: input.licenseId ?? null,
    maintenanceUntil: input.maintenanceUntil ?? null,
    name: input.name.trim(),
    ownerOperatorId: input.ownerOperatorId ?? STUB_CURRENT_OPERATOR_ID,
    productId: STUB_PRODUCTS.privateEdition.id,
    status: 'planned',
    version: 1,
  };
  state.instances.unshift(row);
  return respond({ deployment: toInstance(row) });
}

export async function stubUpdateDeployment(
  deploymentId: string,
  input: UpdateDeploymentInput,
): Promise<UpdateDeploymentResult> {
  const row = instanceRowById(deploymentId);
  if (row.status === 'retired') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  if (input.name !== undefined && input.name.trim() !== '') {
    row.name = input.name.trim();
  }
  if (input.environmentRef !== undefined) {
    row.environmentRef = input.environmentRef.trim() || null;
  }
  if (input.goLiveOn !== undefined) {
    row.goLiveOn = input.goLiveOn;
  }
  if (input.maintenanceUntil !== undefined) {
    row.maintenanceUntil = input.maintenanceUntil;
  }
  if (input.ownerOperatorId !== undefined) {
    row.ownerOperatorId = input.ownerOperatorId;
  }
  row.version += 1;
  return respond({ deployment: toInstance(row) });
}

const TRANSITION_TARGET: Readonly<
  Record<DeploymentTransitionAction, DeploymentInstanceStatus>
> = {
  end_maintenance: 'active',
  go_live: 'active',
  retire: 'retired',
  start_maintenance: 'maintenance',
};

const TRANSITION_ALLOWED_FROM: Readonly<
  Record<DeploymentTransitionAction, DeploymentInstanceStatus[]>
> = {
  end_maintenance: ['maintenance'],
  go_live: ['planned'],
  retire: ['active', 'maintenance', 'planned'],
  start_maintenance: ['active'],
};

export async function stubTransitionDeployment(
  deploymentId: string,
  input: DeploymentTransitionInput,
): Promise<DeploymentTransitionResult> {
  const row = instanceRowById(deploymentId);
  if (input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  if (!TRANSITION_ALLOWED_FROM[input.action].includes(row.status)) {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (input.action === 'go_live' && (row.goLiveOn ?? '') === '') {
    fail({
      code: 'STATE_CONFLICT',
      message: '登记上线需要先补充上线日期（go_live_on）',
      status: 409,
    });
  }
  if (input.action === 'retire' && (input.reason ?? '').trim() === '') {
    fail({
      code: 'VALIDATION_ERROR',
      message: '退役实例必须填写原因',
      status: 400,
    });
  }
  row.status = TRANSITION_TARGET[input.action];
  row.version += 1;
  return respond({
    deployment: {
      currentVersion: row.currentVersion,
      status: row.status,
      version: row.version,
    },
  });
}

export async function stubListVersionRecords(
  deploymentId: string,
): Promise<VersionRecordListResult> {
  const row = instanceRowById(deploymentId);
  return respond({
    items: state.versionRecords
      .filter((item) => item.instanceId === row.id)
      .toSorted((left, right) => (left.executedOn < right.executedOn ? 1 : -1))
      .map((item) => ({ ...item })),
  });
}

/**
 * 登记升级结果（**只追加**）。
 *
 * 版本推进规则（桩内约定，登记为推导项）：
 * - `succeeded`：当前版本推进到 `toVersion`；
 * - `failed` / `rolled_back`：当前版本保持不变（失败与回滚都不会改变实例实际版本）。
 */
export async function stubCreateVersionRecord(
  deploymentId: string,
  input: CreateVersionRecordInput,
): Promise<CreateVersionRecordResult> {
  const row = instanceRowById(deploymentId);
  if (row.status === 'retired') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (
    (input.fromVersion ?? '').trim() === '' ||
    (input.toVersion ?? '').trim() === ''
  ) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '请填写升级前后版本',
      status: 400,
    });
  }
  if (input.executedOn.trim() === '') {
    fail({ code: 'VALIDATION_ERROR', message: '请填写执行日期', status: 400 });
  }
  if (sameVersion(input.toVersion, input.fromVersion)) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '升级后版本不能与升级前版本相同',
      status: 400,
    });
  }
  if (!sameVersion(input.fromVersion, row.currentVersion)) {
    fail({ code: 'STATE_CONFLICT', reason: 'VERSION_MISMATCH', status: 409 });
  }
  state.sequence += 1;
  const record = {
    createdAt: new Date().toISOString(),
    executedBy: STUB_CURRENT_OPERATOR_ID,
    executedOn: input.executedOn,
    fromVersion: input.fromVersion.trim(),
    id: `77777777-7777-4777-8777-${String(state.sequence).padStart(12, '0')}`,
    impactNote: input.impactNote?.trim() || null,
    instanceId: row.id,
    result: input.result,
    rollbackNote: input.rollbackNote?.trim() || null,
    toVersion: input.toVersion.trim(),
  };
  state.versionRecords.unshift(record);
  if (input.result === 'succeeded') {
    row.currentVersion = record.toVersion;
  }
  row.lastVersionRecordAt = record.createdAt;
  row.version += 1;
  return respond({
    deployment: { currentVersion: row.currentVersion },
    versionRecord: { ...record },
  });
}
