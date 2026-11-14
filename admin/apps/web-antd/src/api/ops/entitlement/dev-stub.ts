import type {
  StubChangeRequestRow,
  StubLicenseRow,
  StubSnapshotRow,
  StubSubscriptionRow,
} from './fixtures';
/**
 * 开发态权益契约桩（仅在 `VITE_OPS_MOCK=true` 的非生产构建里被动态加载）。
 *
 * 目的：在 `udone` 的 ops entitlement API 尚未交付时，页面可以走通全部状态
 * （loading / empty / error / validation / permission / conflict / 高风险确认），
 * 且**不冒充真实集成**——页面同时展示「开发态数据」提示。
 *
 * 桩刻意复刻服务端不变量，否则前端会在假的成功里漏掉真实错误分支：
 * - 来源合同未生效 → 409 `STATE_CONFLICT`；同一条目重复开通 → 409 `CONFLICT`；
 * - 变更申请执行前必须 `approved`，否则 409 `STATE_CONFLICT` + `APPROVAL_REQUIRED`；
 * - 审批人 = 申请人 → 403 `FORBIDDEN` + `SEGREGATION_OF_DUTY`（契约 CHECK）；
 * - `version` 不匹配 → 409 `CONFLICT`（前端必须刷新，不得本地覆盖）；
 * - 永久授权带 `validTo` → 400 `VALIDATION_ERROR`（契约 CHECK 反向约束）；
 * - 快照**只追加**：任何变更都生成新快照并推进 `current_snapshot_id`，历史对象不改写。
 */
import type {
  ChangeRequestDetail,
  ChangeRequestListQuery,
  ChangeRequestListResult,
  ChangeRequestTransitionInput,
  ChangeRequestTransitionResult,
  CreateChangeRequestInput,
  CreateChangeRequestResult,
  CreateLicenseInput,
  CreateLicenseResult,
  CreateSubscriptionInput,
  CreateSubscriptionResult,
  EntitlementChangeRequest,
  EntitlementSnapshot,
  EntitlementSnapshotLine,
  EntitlementSnapshotSummary,
  EntitlementStatus,
  EntitlementSummary,
  EntitlementTransitionInput,
  EntitlementTransitionResult,
  License,
  LicenseDetail,
  LicenseListQuery,
  LicenseListResult,
  SnapshotListQuery,
  SnapshotListResult,
  SnapshotSummary,
  Subscription,
  SubscriptionDetail,
  SubscriptionListQuery,
  SubscriptionListResult,
} from './types';

import { OpsApiError, resolveUserMessage } from '#/api/adapter/errors';

import {
  STUB_CHANGE_REQUESTS,
  STUB_CONTRACT_ITEMS,
  STUB_CONTRACTS,
  STUB_CURRENT_OPERATOR_ID,
  STUB_CUSTOMERS,
  STUB_DEPLOYMENTS,
  STUB_LICENSES,
  STUB_OPERATORS,
  STUB_PRODUCTS,
  STUB_SNAPSHOTS,
  STUB_SUBSCRIPTIONS,
} from './fixtures';

const STUB_LATENCY_MS = 120;
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_WHITELIST = new Set([10, 15, 20, 30, 50, 100]);

interface StubState {
  changeRequests: StubChangeRequestRow[];
  licenses: StubLicenseRow[];
  sequence: number;
  snapshots: StubSnapshotRow[];
  subscriptions: StubSubscriptionRow[];
}

function cloneState(): StubState {
  return {
    changeRequests: STUB_CHANGE_REQUESTS.map((row) => ({
      ...row,
      afterSummary: { features: [...(row.afterSummary.features ?? [])] },
      beforeSummary: { features: [...(row.beforeSummary.features ?? [])] },
    })),
    licenses: STUB_LICENSES.map((row) => ({ ...row })),
    sequence: 900,
    snapshots: STUB_SNAPSHOTS.map((row) => ({
      ...row,
      lines: row.lines.map((line) => ({ ...line })),
    })),
    subscriptions: STUB_SUBSCRIPTIONS.map((row) => ({ ...row })),
  };
}

let state: StubState = cloneState();

/** 仅供单测重置桩状态。 */
export function resetStubEntitlementState(): void {
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
    customerId === STUB_CUSTOMERS.c1.id ? STUB_CUSTOMERS.c1 : STUB_CUSTOMERS.c2;
  return {
    customerNo: customer.customerNo,
    id: customer.id,
    name: customer.name,
  };
}

function operatorRef(id: null | string | undefined) {
  if (!id) {
    return null;
  }
  const found = Object.values(STUB_OPERATORS).find((item) => item.id === id);
  if (found) {
    return { displayName: found.displayName, id: found.id };
  }
  if (id === STUB_CURRENT_OPERATOR_ID) {
    return { displayName: '开发桩·演示运营（虚构）', id };
  }
  return { id };
}

function cents(value: number): number {
  return Math.round(value * 100);
}

/** 合同条目 → 来源合同（桩内只用于校验合同是否生效）。 */
function contractOfItem(contractItemId: string) {
  return contractItemId === STUB_CONTRACT_ITEMS.itemDraft
    ? STUB_CONTRACTS.draft
    : STUB_CONTRACTS.active;
}

function fromCents(value: number): number {
  return value / 100;
}

/** 服务端口径的快照摘要：计数与额度合计都在这里算，前端只格式化。 */
function summarizeSnapshot(lines: EntitlementSnapshotLine[]): SnapshotSummary {
  let quotaCents = 0;
  let hasQuota = false;
  for (const line of lines) {
    if (line.quota !== null) {
      hasQuota = true;
      quotaCents += cents(line.quota);
    }
  }
  return {
    enabledCount: lines.filter((line) => line.enabled).length,
    featureCount: lines.length,
    quotaTotal: hasQuota ? fromCents(quotaCents) : null,
  };
}

function toSnapshot(row: StubSnapshotRow): EntitlementSnapshot {
  return {
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    createdBy: operatorRef(row.createdBy) ?? { id: row.createdBy },
    id: row.id,
    lines: row.lines.map((line) => ({ ...line })),
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    targetRef: row.targetRef,
    targetScope: row.targetScope,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

function toSnapshotSummary(row: StubSnapshotRow): EntitlementSnapshotSummary {
  return {
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    createdBy: operatorRef(row.createdBy) ?? { id: row.createdBy },
    id: row.id,
    lineCount: row.lines.length,
    snapshotSummary: summarizeSnapshot(row.lines),
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    targetScope: row.targetScope,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

function snapshotRowById(snapshotId: string): StubSnapshotRow {
  const row = state.snapshots.find((item) => item.id === snapshotId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

/** 内容哈希：桩内用稳定字符串代替真实 sha256，只为演示 `UNIQUE(source_type, source_id, content_hash)`。 */
function contentHashOf(lines: EntitlementSnapshotLine[]): string {
  const canonical = [...lines]
    .toSorted((left, right) => left.featureKey.localeCompare(right.featureKey))
    .map(
      (line) =>
        `${line.featureKey}:${line.enabled ? 1 : 0}:${line.quota ?? '-'}:${
          line.termMonths ?? '-'
        }`,
    )
    .join('|');
  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 31 + (canonical.codePointAt(index) ?? 0)) % 1_000_000_007;
  }
  return `stub-${hash.toString(16)}`;
}

/**
 * 追加一条快照（**只 INSERT**）。
 * 同 `(source_type, source_id, content_hash)` 已存在时复用原快照，模拟唯一约束防重复发放。
 */
function appendSnapshot(input: {
  createdBy: string;
  customerId: string;
  lines: EntitlementSnapshotLine[];
  sourceId: string;
  sourceType: 'change_request' | 'contract_item';
  targetRef: null | string;
  targetScope: 'private_instance' | 'saas_tenant';
  validFrom: null | string;
  validTo: null | string;
}): StubSnapshotRow {
  const contentHash = contentHashOf(input.lines);
  const existing = state.snapshots.find(
    (row) =>
      row.sourceType === input.sourceType &&
      row.sourceId === input.sourceId &&
      row.contentHash === contentHash,
  );
  if (existing) {
    return existing;
  }
  state.sequence += 1;
  const row: StubSnapshotRow = {
    contentHash,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
    customerId: input.customerId,
    id: `cccccccc-cccc-4ccc-8ccc-${String(state.sequence).padStart(12, '0')}`,
    lines: input.lines.map((line) => ({ ...line })),
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    targetRef: input.targetRef,
    targetScope: input.targetScope,
    validFrom: input.validFrom,
    validTo: input.validTo,
  };
  state.snapshots.push(row);
  return row;
}

function toFeatures(
  features: {
    displayName?: string;
    enabled: boolean;
    featureKey: string;
    quota?: null | number;
    termMonths?: null | number;
  }[],
): EntitlementSnapshotLine[] {
  return features.map((feature) => ({
    displayNameSnapshot: feature.displayName?.trim() || feature.featureKey,
    enabled: feature.enabled,
    featureKey: feature.featureKey,
    quota: feature.quota ?? null,
    termMonths: feature.termMonths ?? null,
  }));
}

function snapshotLinesOf(snapshotId: null | string): EntitlementSnapshotLine[] {
  if (!snapshotId) {
    return [];
  }
  return snapshotRowById(snapshotId).lines.map((line) => ({ ...line }));
}

function summaryOfLines(lines: EntitlementSnapshotLine[]): EntitlementSummary {
  return {
    features: lines.map((line) => ({
      displayName: line.displayNameSnapshot,
      enabled: line.enabled,
      featureKey: line.featureKey,
      quota: line.quota,
      termMonths: line.termMonths,
    })),
  };
}

// ---------------------------------------------------------------- 订阅

function toSubscription(row: StubSubscriptionRow): Subscription {
  const snapshot = snapshotRowById(row.currentSnapshotId);
  const product =
    row.productId === STUB_PRODUCTS.saas.id
      ? STUB_PRODUCTS.saas
      : STUB_PRODUCTS.privateEdition;
  return {
    autoRenewIntent: row.autoRenewIntent,
    billingCycle: row.billingCycle,
    contractId: row.contractId,
    contractItemId: row.contractItemId,
    currentSnapshotId: row.currentSnapshotId,
    customer: customerRef(row.customerId),
    endsOn: row.endsOn,
    id: row.id,
    product: { code: product.code, id: product.id, name: product.name },
    snapshotSummary: summarizeSnapshot(snapshot.lines),
    startsOn: row.startsOn,
    status: row.status,
    subscriptionNo: row.subscriptionNo,
    version: row.version,
  };
}

function subscriptionRowById(subscriptionId: string): StubSubscriptionRow {
  const row = state.subscriptions.find((item) => item.id === subscriptionId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

/** 该主体关联的快照：来源条目快照 + 该主体变更申请产生的快照（按 `createdAt` 倒序）。 */
function snapshotsForSubject(
  subjectType: 'license' | 'subscription',
  subjectId: string,
  contractItemId: string,
): EntitlementSnapshotSummary[] {
  const changeRequestIds = new Set(
    state.changeRequests
      .filter(
        (row) => row.subjectId === subjectId && row.subjectType === subjectType,
      )
      .map((row) => row.id),
  );
  return state.snapshots
    .filter(
      (row) =>
        row.sourceId === contractItemId || changeRequestIds.has(row.sourceId),
    )
    .toSorted((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
    .map((row) => toSnapshotSummary(row));
}

function toChangeRequest(row: StubChangeRequestRow): EntitlementChangeRequest {
  return {
    afterSummary: row.afterSummary,
    approvedAt: row.approvedAt,
    approvedBy: operatorRef(row.approvedBy),
    beforeSummary: row.beforeSummary,
    changeType: row.changeType,
    commandId: row.commandId,
    createdAt: row.createdAt,
    executedAt: row.executedAt,
    id: row.id,
    proposedSnapshotId: row.proposedSnapshotId,
    reason: row.reason,
    requestedBy: operatorRef(row.requestedBy),
    sourceContractId: row.sourceContractId,
    status: row.status,
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    version: row.version,
  };
}

export async function stubListSubscriptions(
  query: SubscriptionListQuery = {},
): Promise<SubscriptionListResult> {
  let rows = [...state.subscriptions];
  if (query.customerId) {
    rows = rows.filter((row) => row.customerId === query.customerId);
  }
  if (query.productId) {
    rows = rows.filter((row) => row.productId === query.productId);
  }
  if (query.billingCycle) {
    rows = rows.filter((row) => row.billingCycle === query.billingCycle);
  }
  if (query.endsFrom) {
    rows = rows.filter((row) => (row.endsOn ?? '') >= (query.endsFrom ?? ''));
  }
  if (query.endsTo) {
    rows = rows.filter((row) => (row.endsOn ?? '') <= (query.endsTo ?? ''));
  }
  if (query.status && query.status.length > 0) {
    const allowed = new Set<string>(query.status);
    rows = rows.filter((row) => allowed.has(row.status));
  }
  const direction = query.order === 'asc' ? 1 : -1;
  rows = rows.toSorted((left, right) => {
    if (left.startsOn === right.startsOn) {
      return left.subscriptionNo < right.subscriptionNo
        ? direction
        : -direction;
    }
    return left.startsOn < right.startsOn ? direction : -direction;
  });
  return respond(
    paginate(
      rows.map((row) => toSubscription(row)),
      query.page,
      query.pageSize,
    ),
  );
}

export async function stubGetSubscription(
  subscriptionId: string,
): Promise<SubscriptionDetail> {
  const row = subscriptionRowById(subscriptionId);
  return respond({
    changeRequests: state.changeRequests
      .filter(
        (item) =>
          item.subjectId === subscriptionId &&
          item.subjectType === 'subscription',
      )
      .toSorted((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
      .map((item) => toChangeRequest(item)),
    snapshot: toSnapshot(snapshotRowById(row.currentSnapshotId)),
    snapshots: snapshotsForSubject('subscription', row.id, row.contractItemId),
    subscription: toSubscription(row),
  });
}

export async function stubCreateSubscription(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  if (!input.customerId || !input.contractItemId) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '请选择客户与来源合同条目',
      status: 400,
    });
  }
  if (!input.startsOn) {
    fail({ code: 'VALIDATION_ERROR', message: '请填写生效日', status: 400 });
  }
  if (input.endsOn && input.endsOn < input.startsOn) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '到期日不能早于生效日',
      status: 400,
    });
  }
  const contract = contractOfItem(input.contractItemId);
  if (contract.status !== 'active') {
    // 契约约束：来源合同必须 active（或 signed 且 effective_on <= today）
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  const duplicated = state.subscriptions.some(
    (row) =>
      row.contractItemId === input.contractItemId &&
      row.customerId === input.customerId &&
      row.status !== 'revoked' &&
      row.status !== 'expired',
  );
  if (duplicated) {
    fail({ code: 'CONFLICT', status: 409 });
  }

  const snapshot = appendSnapshot({
    createdBy: STUB_CURRENT_OPERATOR_ID,
    customerId: input.customerId,
    lines: toFeatures(input.features),
    sourceId: input.contractItemId,
    sourceType: 'contract_item',
    targetRef: null,
    targetScope: 'saas_tenant',
    validFrom: input.startsOn,
    validTo: input.endsOn ?? null,
  });
  state.sequence += 1;
  const row: StubSubscriptionRow = {
    autoRenewIntent: input.autoRenewIntent ?? false,
    billingCycle: input.billingCycle,
    contractId: contract.id,
    contractItemId: input.contractItemId,
    currentSnapshotId: snapshot.id,
    customerId: input.customerId,
    endsOn: input.endsOn ?? null,
    id: `88888888-8888-4888-8888-${String(state.sequence).padStart(12, '0')}`,
    productId: STUB_PRODUCTS.saas.id,
    startsOn: input.startsOn,
    status: 'draft',
    subscriptionNo: `SUB-2026-${String(state.sequence).padStart(6, '0')}`,
    version: 1,
  };
  state.subscriptions.unshift(row);
  return respond({
    snapshot: { id: snapshot.id },
    subscription: toSubscription(row),
  });
}

export async function stubTransitionSubscription(
  subscriptionId: string,
  input: EntitlementTransitionInput,
): Promise<EntitlementTransitionResult> {
  const row = subscriptionRowById(subscriptionId);
  if (input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  const allowedByStatus: Record<string, EntitlementStatus | null> = {
    approve: row.status === 'pending_approval' ? 'active' : null,
    reject: row.status === 'pending_approval' ? 'draft' : null,
    submit: row.status === 'draft' ? 'pending_approval' : null,
  };
  const next = allowedByStatus[input.action];
  if (next === undefined || next === null) {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (input.action === 'submit' && !row.currentSnapshotId) {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  row.status = next;
  row.version += 1;
  return respond({
    subscription: {
      allowedActions: next === 'pending_approval' ? ['approve', 'reject'] : [],
      status: next,
      version: row.version,
    },
  });
}

// ---------------------------------------------------------------- 授权

function toLicense(row: StubLicenseRow): License {
  const snapshot = snapshotRowById(row.currentSnapshotId);
  const deployment =
    row.deploymentInstanceId === STUB_DEPLOYMENTS.d1.id
      ? STUB_DEPLOYMENTS.d1
      : STUB_DEPLOYMENTS.d2;
  return {
    contractId: row.contractId,
    contractItemId: row.contractItemId,
    currentSnapshotId: row.currentSnapshotId,
    customer: customerRef(row.customerId),
    deployment: {
      id: deployment.id,
      instanceNo: deployment.instanceNo,
      name: deployment.name,
      status: deployment.status,
    },
    deploymentInstanceId: row.deploymentInstanceId,
    id: row.id,
    licenseMode: row.licenseMode,
    licenseNo: row.licenseNo,
    maintenanceUntil: row.maintenanceUntil,
    snapshotSummary: summarizeSnapshot(snapshot.lines),
    status: row.status,
    validFrom: row.validFrom,
    validTo: row.validTo,
    version: row.version,
  };
}

function licenseRowById(licenseId: string): StubLicenseRow {
  const row = state.licenses.find((item) => item.id === licenseId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

export async function stubListLicenses(
  query: LicenseListQuery = {},
): Promise<LicenseListResult> {
  let rows = [...state.licenses];
  if (query.customerId) {
    rows = rows.filter((row) => row.customerId === query.customerId);
  }
  if (query.deploymentInstanceId) {
    rows = rows.filter(
      (row) => row.deploymentInstanceId === query.deploymentInstanceId,
    );
  }
  if (query.licenseMode) {
    rows = rows.filter((row) => row.licenseMode === query.licenseMode);
  }
  if (query.endsFrom) {
    rows = rows.filter((row) => (row.validTo ?? '') >= (query.endsFrom ?? ''));
  }
  if (query.endsTo) {
    rows = rows.filter((row) => (row.validTo ?? '') <= (query.endsTo ?? ''));
  }
  if (query.status && query.status.length > 0) {
    const allowed = new Set<string>(query.status);
    rows = rows.filter((row) => allowed.has(row.status));
  }
  const direction = query.order === 'asc' ? 1 : -1;
  rows = rows.toSorted((left, right) => {
    if (left.validFrom === right.validFrom) {
      return left.licenseNo < right.licenseNo ? direction : -direction;
    }
    return left.validFrom < right.validFrom ? direction : -direction;
  });
  return respond(
    paginate(
      rows.map((row) => toLicense(row)),
      query.page,
      query.pageSize,
    ),
  );
}

export async function stubGetLicense(
  licenseId: string,
): Promise<LicenseDetail> {
  const row = licenseRowById(licenseId);
  const license = toLicense(row);
  return respond({
    changeRequests: state.changeRequests
      .filter(
        (item) =>
          item.subjectId === licenseId && item.subjectType === 'license',
      )
      .toSorted((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
      .map((item) => toChangeRequest(item)),
    deployment: license.deployment ?? null,
    license,
    snapshot: toSnapshot(snapshotRowById(row.currentSnapshotId)),
    snapshots: snapshotsForSubject('license', row.id, row.contractItemId),
  });
}

export async function stubCreateLicense(
  input: CreateLicenseInput,
): Promise<CreateLicenseResult> {
  if (!input.customerId || !input.contractItemId) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '请选择客户与来源合同条目',
      status: 400,
    });
  }
  if (!input.deploymentInstanceId) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '私有授权必须指定部署实例',
      status: 400,
    });
  }
  const contract = contractOfItem(input.contractItemId);
  if (contract.status !== 'active') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (input.licenseMode === 'perpetual' && input.validTo) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '永久授权的到期日必须留空（永久授权 ≠ 永久更新）',
      status: 400,
    });
  }
  if (input.licenseMode === 'term' && !input.validTo) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '限期授权必须填写到期日',
      status: 400,
    });
  }
  if (input.validTo && input.validTo < input.validFrom) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '到期日不能早于生效日',
      status: 400,
    });
  }
  const snapshot = appendSnapshot({
    createdBy: STUB_CURRENT_OPERATOR_ID,
    customerId: input.customerId,
    lines: toFeatures(input.features),
    sourceId: input.contractItemId,
    sourceType: 'contract_item',
    targetRef: input.deploymentInstanceId,
    targetScope: 'private_instance',
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
  });
  state.sequence += 1;
  const row: StubLicenseRow = {
    contractId: contract.id,
    contractItemId: input.contractItemId,
    currentSnapshotId: snapshot.id,
    customerId: input.customerId,
    deploymentInstanceId: input.deploymentInstanceId,
    id: `99999999-9999-4999-8999-${String(state.sequence).padStart(12, '0')}`,
    licenseMode: input.licenseMode,
    licenseNo: `LIC-2026-${String(state.sequence).padStart(6, '0')}`,
    maintenanceUntil: input.maintenanceUntil ?? null,
    status: 'draft',
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    version: 1,
  };
  state.licenses.unshift(row);
  return respond({ license: toLicense(row), snapshot: { id: snapshot.id } });
}

export async function stubTransitionLicense(
  licenseId: string,
  input: EntitlementTransitionInput,
): Promise<EntitlementTransitionResult> {
  const row = licenseRowById(licenseId);
  if (input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  const allowedByStatus: Record<string, EntitlementStatus | null> = {
    approve: row.status === 'pending_approval' ? 'active' : null,
    reject: row.status === 'pending_approval' ? 'draft' : null,
    submit: row.status === 'draft' ? 'pending_approval' : null,
  };
  const next = allowedByStatus[input.action];
  if (next === undefined || next === null) {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  row.status = next;
  row.version += 1;
  return respond({
    subscription: {
      allowedActions: next === 'pending_approval' ? ['approve', 'reject'] : [],
      status: next,
      version: row.version,
    },
  });
}

// ---------------------------------------------------------------- 变更申请

function changeRequestRowById(changeRequestId: string): StubChangeRequestRow {
  const row = state.changeRequests.find((item) => item.id === changeRequestId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

function subjectOf(
  subjectType: 'license' | 'subscription',
  subjectId: string,
): StubLicenseRow | StubSubscriptionRow {
  return subjectType === 'subscription'
    ? subscriptionRowById(subjectId)
    : licenseRowById(subjectId);
}

function toChangeRequestDetail(row: StubChangeRequestRow): ChangeRequestDetail {
  return {
    changeRequest: toChangeRequest(row),
    command: row.commandId
      ? {
          id: row.commandId,
          status: row.status === 'failed' ? 'failed' : 'succeeded',
        }
      : null,
    diff: { after: row.afterSummary, before: row.beforeSummary },
  };
}

export async function stubListChangeRequests(
  query: ChangeRequestListQuery = {},
): Promise<ChangeRequestListResult> {
  let rows = [...state.changeRequests];
  if (query.subjectType) {
    rows = rows.filter((row) => row.subjectType === query.subjectType);
  }
  if (query.changeType) {
    rows = rows.filter((row) => row.changeType === query.changeType);
  }
  if (query.status && query.status.length > 0) {
    const allowed = new Set<string>(query.status);
    rows = rows.filter((row) => allowed.has(row.status));
  }
  if (query.requestedBy) {
    rows = rows.filter((row) => row.requestedBy === query.requestedBy);
  }
  if (query.customerId) {
    rows = rows.filter((row) => {
      const subject = state.subscriptions.find(
        (item) => item.id === row.subjectId,
      );
      const license = state.licenses.find((item) => item.id === row.subjectId);
      const customerId = subject?.customerId ?? license?.customerId ?? '';
      return customerId === query.customerId;
    });
  }
  rows = rows.toSorted((left, right) =>
    left.createdAt < right.createdAt ? 1 : -1,
  );
  return respond(
    paginate(
      rows.map((row) => toChangeRequest(row)),
      query.page,
      query.pageSize,
    ),
  );
}

export async function stubGetChangeRequest(
  changeRequestId: string,
): Promise<ChangeRequestDetail> {
  return respond(toChangeRequestDetail(changeRequestRowById(changeRequestId)));
}

async function createChangeRequest(
  subjectType: 'license' | 'subscription',
  subjectId: string,
  input: CreateChangeRequestInput,
): Promise<CreateChangeRequestResult> {
  if (input.reason.trim() === '') {
    fail({
      code: 'VALIDATION_ERROR',
      message: '请填写变更原因（会写入审计）',
      status: 400,
    });
  }
  if (
    !Array.isArray(input.proposedFeatures) ||
    input.proposedFeatures.length === 0
  ) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '变更申请必须包含权限行（proposed_features）',
      status: 400,
    });
  }
  const subject = subjectOf(subjectType, subjectId);
  if (subject.status !== 'active' && subject.status !== 'suspended') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }

  state.sequence += 1;
  const changeRequestId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(state.sequence).padStart(12, '0')}`;
  const beforeLines = snapshotLinesOf(subject.currentSnapshotId);
  const targetScope =
    subjectType === 'license' ? 'private_instance' : 'saas_tenant';
  const targetRef =
    subjectType === 'license' && 'deploymentInstanceId' in subject
      ? subject.deploymentInstanceId
      : null;
  const subjectValidFrom =
    'validFrom' in subject ? (subject.validFrom ?? null) : null;
  const subjectValidTo =
    'validTo' in subject ? (subject.validTo ?? null) : (subject.endsOn ?? null);
  const snapshot = appendSnapshot({
    createdBy: STUB_CURRENT_OPERATOR_ID,
    customerId: subject.customerId,
    lines: toFeatures(input.proposedFeatures),
    sourceId: changeRequestId,
    sourceType: 'change_request',
    targetRef,
    targetScope,
    validFrom: input.effectiveOn ?? subjectValidFrom,
    validTo: subjectValidTo,
  });

  const row: StubChangeRequestRow = {
    afterSummary: summaryOfLines(snapshot.lines),
    approvedAt: null,
    approvedBy: null,
    beforeSummary: summaryOfLines(beforeLines),
    changeType: input.changeType,
    commandId: null,
    createdAt: new Date().toISOString(),
    executedAt: null,
    id: changeRequestId,
    proposedSnapshotId: snapshot.id,
    reason: input.reason.trim(),
    requestedBy: STUB_CURRENT_OPERATOR_ID,
    sourceContractId: subject.contractId,
    status: 'pending_approval',
    subjectId,
    subjectType,
    version: 1,
  };
  state.changeRequests.unshift(row);
  return {
    changeRequest: toChangeRequest(row),
    diff: { after: row.afterSummary, before: row.beforeSummary },
  };
}

export async function stubCreateSubscriptionChangeRequest(
  subscriptionId: string,
  input: CreateChangeRequestInput,
): Promise<CreateChangeRequestResult> {
  return respond(
    await createChangeRequest('subscription', subscriptionId, input),
  );
}

export async function stubCreateLicenseChangeRequest(
  licenseId: string,
  input: CreateChangeRequestInput,
): Promise<CreateChangeRequestResult> {
  return respond(await createChangeRequest('license', licenseId, input));
}

/** 执行成功后的主体状态推进（由变更类型决定，模拟服务端 RPC 的副作用）。 */
function applyExecutedChange(row: StubChangeRequestRow): void {
  const subject = subjectOf(row.subjectType, row.subjectId);
  switch (row.changeType) {
    case 'expire': {
      subject.status = 'expired';
      break;
    }
    case 'resume': {
      subject.status = 'active';
      break;
    }
    case 'revoke': {
      subject.status = 'revoked';
      break;
    }
    case 'suspend': {
      subject.status = 'suspended';
      break;
    }
    default: {
      // 延期/升级/降级/额度变更：只推进权益快照，不改业务状态
      break;
    }
  }
  subject.currentSnapshotId =
    row.proposedSnapshotId ?? subject.currentSnapshotId;
  subject.version += 1;
}

export async function stubTransitionChangeRequest(
  changeRequestId: string,
  input: ChangeRequestTransitionInput,
): Promise<ChangeRequestTransitionResult> {
  const row = changeRequestRowById(changeRequestId);
  if (input.reason.trim() === '') {
    fail({
      code: 'VALIDATION_ERROR',
      message: '请填写操作原因（会写入审计）',
      status: 400,
    });
  }
  if (input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }

  switch (input.action) {
    case 'approve': {
      if (row.status !== 'pending_approval') {
        fail({ code: 'STATE_CONFLICT', status: 409 });
      }
      if (row.requestedBy === STUB_CURRENT_OPERATOR_ID) {
        fail({ code: 'FORBIDDEN', reason: 'SEGREGATION_OF_DUTY', status: 403 });
      }
      row.status = 'approved';
      row.approvedAt = new Date().toISOString();
      row.approvedBy = STUB_CURRENT_OPERATOR_ID;
      break;
    }
    case 'cancel': {
      if (!['approved', 'draft', 'pending_approval'].includes(row.status)) {
        fail({ code: 'STATE_CONFLICT', status: 409 });
      }
      row.status = 'cancelled';
      break;
    }
    case 'execute': {
      if (row.status !== 'approved') {
        fail({
          code: 'STATE_CONFLICT',
          reason: 'APPROVAL_REQUIRED',
          status: 409,
        });
      }
      row.status = 'executing';
      state.sequence += 1;
      row.commandId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(state.sequence).padStart(12, '0')}`;
      applyExecutedChange(row);
      row.status = 'executed';
      row.executedAt = new Date().toISOString();
      break;
    }
    case 'reject': {
      if (row.status !== 'pending_approval') {
        fail({ code: 'STATE_CONFLICT', status: 409 });
      }
      if (row.requestedBy === STUB_CURRENT_OPERATOR_ID) {
        fail({ code: 'FORBIDDEN', reason: 'SEGREGATION_OF_DUTY', status: 403 });
      }
      row.status = 'rejected';
      break;
    }
    case 'retry': {
      if (row.status !== 'failed') {
        fail({
          code: 'STATE_CONFLICT',
          reason: 'PERMANENT_ERROR',
          status: 409,
        });
      }
      row.status = 'executing';
      applyExecutedChange(row);
      row.status = 'executed';
      row.executedAt = new Date().toISOString();
      break;
    }
    default: {
      fail({ code: 'VALIDATION_ERROR', status: 400 });
    }
  }

  row.version += 1;
  return respond({
    changeRequest: { status: row.status, version: row.version },
    command: row.commandId ? { id: row.commandId, status: 'pending' } : null,
  });
}

// ---------------------------------------------------------------- 快照

export async function stubGetSnapshot(
  snapshotId: string,
): Promise<EntitlementSnapshot> {
  return respond(toSnapshot(snapshotRowById(snapshotId)));
}

export async function stubListSnapshots(
  query: SnapshotListQuery = {},
): Promise<SnapshotListResult> {
  let rows = [...state.snapshots];
  if (query.sourceType) {
    rows = rows.filter((row) => row.sourceType === query.sourceType);
  }
  if (query.sourceId) {
    rows = rows.filter((row) => row.sourceId === query.sourceId);
  }
  if (query.targetScope) {
    rows = rows.filter((row) => row.targetScope === query.targetScope);
  }
  if (query.customerId) {
    rows = rows.filter((row) => row.customerId === query.customerId);
  }
  rows = rows.toSorted((left, right) =>
    left.createdAt < right.createdAt ? 1 : -1,
  );
  return respond(
    paginate(
      rows.map((row) => toSnapshotSummary(row)),
      query.page,
      query.pageSize,
    ),
  );
}
