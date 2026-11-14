import type { FixtureContractRecord } from './fixtures';
import type {
  ContractAttachment,
  ContractCreateInput,
  ContractCreateResult,
  ContractDetail,
  ContractEntitlementPreview,
  ContractEntity,
  ContractItem,
  ContractItemInput,
  ContractListQuery,
  ContractPage,
  ContractRenewalInput,
  ContractRenewalResult,
  ContractStatus,
  ContractTransitionAction,
  ContractTransitionInput,
  ContractTransitionResult,
  ContractUpdateInput,
  ContractVersionEntry,
} from './index';

/**
 * contract 域开发态桩（仅 `VITE_OPS_MOCK=true`）。
 *
 * 行为尽量贴契约 §3.3 状态机：状态只能经 `transition` 改变、生效时写版本快照、
 * 生效后禁止 PATCH、续约另建新合同。真实判定（销售方式是否开放、客户状态、
 * 财务/交付阻塞）必须由后端完成。
 */
import { OpsApiError } from '#/api/adapter/errors';

import { FIXTURE_PACKAGES } from '../catalog/fixtures';
import { FIXTURE_CUSTOMERS } from '../customer/fixtures';
import { FIXTURE_CONTRACTS } from './fixtures';

const STUB_LATENCY_MS = 60;

/** 续约提前窗口（天）：超过该窗口且合同仍 active 时拒绝，需业务显式确认 [推导]。 */
const RENEWAL_WINDOW_DAYS = 90;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), STUB_LATENCY_MS);
  });
}

interface StoreRecord extends FixtureContractRecord {
  versions: ContractVersionEntry[];
}

const store: StoreRecord[] = clone(FIXTURE_CONTRACTS).map((record) => ({
  ...record,
  versions:
    record.contract.status === 'draft' || record.contract.status === 'reviewing'
      ? []
      : [
          {
            changeReason: '合同生效（示例快照）',
            createdAt: record.contract.effectiveOn
              ? `${record.contract.effectiveOn}T00:00:00Z`
              : record.contract.updatedAt,
            createdBy: '示例商务甲',
            snapshotSummary: {
              currency: record.contract.currency,
              effectiveOn: record.contract.effectiveOn,
              expiresOn: record.contract.expiresOn,
              itemCount: record.items.length,
              totalAmount: record.contract.totalAmount,
            },
            versionNo: record.contract.currentVersionNo,
          },
        ],
}));

let contractSequence = 61;
let itemSequence = 5;
let attachmentSequence = 3;

function conflict(message: string): OpsApiError {
  return new OpsApiError({
    code: 'CONFLICT',
    kind: 'http',
    retryable: false,
    status: 409,
    userMessage: message,
  });
}

function stateConflict(message: string, reason?: string): OpsApiError {
  return new OpsApiError({
    code: 'STATE_CONFLICT',
    details: reason ? { reason } : undefined,
    kind: 'http',
    retryable: false,
    status: 409,
    userMessage: message,
  });
}

function validation(message: string): OpsApiError {
  return new OpsApiError({
    code: 'VALIDATION_ERROR',
    kind: 'http',
    retryable: false,
    status: 400,
    userMessage: message,
  });
}

function notFound(): OpsApiError {
  return new OpsApiError({
    code: 'NOT_FOUND',
    kind: 'http',
    retryable: false,
    status: 404,
    userMessage: '合同不存在或已被移除',
  });
}

function findRecord(contractId: string): StoreRecord {
  const record = store.find((item) => item.contract.id === contractId);
  if (!record) {
    throw notFound();
  }
  return record;
}

/** 状态机：当前状态允许的动作，契约 §3.3。 */
const ALLOWED_ACTIONS: Record<ContractStatus, ContractTransitionAction[]> = {
  active: ['terminate', 'expire'],
  draft: ['submit'],
  expired: [],
  reviewing: ['sign', 'withdraw'],
  signed: ['activate', 'expire'],
  terminated: [],
};

function toListItem(record: StoreRecord) {
  const total = record.contract.totalAmount;
  const settled = record.receivables.reduce(
    (sum, item) => sum + (item.outstanding === 0 ? item.amount : 0),
    0,
  );
  return {
    contractNo: record.contract.contractNo,
    currency: record.contract.currency,
    customer: record.contract.customer,
    effectiveOn: record.contract.effectiveOn,
    expiresOn: record.contract.expiresOn,
    id: record.contract.id,
    receivableSummary:
      record.receivables.length === 0
        ? null
        : { outstanding: total - settled, settled, total },
    salesMode: record.contract.salesMode,
    status: record.contract.status,
    totalAmount: total,
  };
}

/**
 * 把表单提交的「价格版本键」解析成价格版本 ID。
 *
 * 契约 §5.3 的版本历史条目未返回 `id`，前端在缺 `id` 时会用 `versionNo` 兜底；
 * 桩在这里统一解析回 `id`，保证条目快照与套餐价格版本可对上（真实后端应直接收 `id`）。
 */
function resolvePriceVersionId(packageId: string, given: string): string {
  const pkg = FIXTURE_PACKAGES.find((item) => item.package.id === packageId);
  const version = pkg?.priceVersions.find(
    (item) => item.id === given || String(item.versionNo) === given,
  );
  return version?.id ?? given;
}

function buildItems(inputs: ContractItemInput[]): ContractItem[] {
  return inputs.map((input) => {
    itemSequence += 1;
    const pkg = FIXTURE_PACKAGES.find(
      (item) => item.package.id === input.packageId,
    );
    return {
      amount: Math.round(input.quantity * input.unitPrice * 100) / 100,
      billingType: pkg?.package.billingType ?? 'periodic',
      id: `cit-${String(itemSequence).padStart(4, '0')}`,
      itemNameSnapshot: pkg?.package.internalName ?? '示例条目（桩）',
      packageId: input.packageId,
      packagePriceVersionId: resolvePriceVersionId(
        input.packageId,
        input.priceVersionId,
      ),
      productId: input.productId,
      quantity: input.quantity,
      salesMode: pkg?.package.salesMode ?? 'saas',
      termMonths: input.termMonths ?? pkg?.package.defaultTermMonths ?? null,
      unitPrice: input.unitPrice,
    };
  });
}

function sumAmount(items: ContractItem[]): number {
  return (
    Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100
  );
}

function resolveCustomerName(customerId: string): string {
  return (
    FIXTURE_CUSTOMERS.find((item) => item.customer.id === customerId)?.customer
      .name ?? '示例客户（桩未解析）'
  );
}

export async function mockFetchContracts(
  query: ContractListQuery = {},
): Promise<ContractPage> {
  const keyword = (query.keyword ?? '').trim();
  const statuses = query.status ?? [];
  const rows = store.filter((record) => {
    if (statuses.length > 0 && !statuses.includes(record.contract.status)) {
      return false;
    }
    if (query.customerId && record.contract.customer.id !== query.customerId) {
      return false;
    }
    if (query.salesMode && record.contract.salesMode !== query.salesMode) {
      return false;
    }
    if (
      query.expiresFrom &&
      (!record.contract.expiresOn ||
        record.contract.expiresOn < query.expiresFrom)
    ) {
      return false;
    }
    if (
      query.expiresTo &&
      (!record.contract.expiresOn ||
        record.contract.expiresOn > query.expiresTo)
    ) {
      return false;
    }
    if (
      keyword !== '' &&
      !`${record.contract.contractNo} ${record.contract.customer.name}`.includes(
        keyword,
      )
    ) {
      return false;
    }
    return true;
  });

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 15;
  const start = (page - 1) * pageSize;
  return delay({
    items: rows
      .slice(start, start + pageSize)
      .map((record) => toListItem(record)),
    page,
    pageSize,
    total: rows.length,
  });
}

export async function mockCreateContract(
  body: ContractCreateInput,
): Promise<ContractCreateResult> {
  if (body.items.length === 0) {
    throw validation('合同至少需要一条条目');
  }
  if (
    body.items.some((item) => !(item.quantity > 0) || !(item.unitPrice >= 0))
  ) {
    throw validation('条目数量与单价必须为有效数字');
  }
  contractSequence += 1;
  const now = new Date().toISOString();
  const items = buildItems(body.items);
  const entity: ContractEntity = {
    businessNote: body.businessNote ?? null,
    contractNo: `HT-2026-${String(contractSequence).padStart(6, '0')}`,
    createdAt: now,
    currency: body.currency,
    currentVersionNo: 1,
    customer: {
      id: body.customerId,
      name: resolveCustomerName(body.customerId),
    },
    effectiveOn: null,
    expiresOn: null,
    id: `con-${String(contractSequence).padStart(4, '0')}`,
    paymentTerms: body.paymentTerms ?? null,
    renewedFromContractId: null,
    salesMode: body.salesMode,
    salesOwner: null,
    signedOn: null,
    status: 'draft',
    statusReason: null,
    taxNote: body.taxNote ?? null,
    totalAmount: sumAmount(items),
    updatedAt: now,
    version: 1,
  };
  store.unshift({
    attachments: [],
    contract: entity,
    items,
    receivables: [],
    versions: [],
  });

  return delay({
    contract: clone(entity),
    entitlementPreview: buildEntitlementFeatures(items),
    items: clone(items),
  });
}

function buildEntitlementFeatures(
  items: ContractItem[],
): ContractEntitlementPreview['features'] {
  const features = new Map<
    string,
    ContractEntitlementPreview['features'][number]
  >();
  for (const item of items) {
    const pkg = FIXTURE_PACKAGES.find(
      (entry) => entry.package.id === item.packageId,
    );
    for (const feature of pkg?.features ?? []) {
      if (!feature.enabled) {
        continue;
      }
      features.set(feature.featureKey, {
        appliesTo: feature.appliesTo,
        displayName: feature.displayName,
        enabled: feature.enabled,
        featureKey: feature.featureKey,
        quota: feature.quota,
        termMonths: feature.termMonths,
      });
    }
  }
  return [...features.values()];
}

export async function mockFetchContract(
  contractId: string,
): Promise<ContractDetail> {
  const record = findRecord(contractId);
  return delay({
    allowedActions: ALLOWED_ACTIONS[record.contract.status],
    attachments: clone(record.attachments),
    contract: clone(record.contract),
    items: clone(record.items),
    licenses: [],
    receivables: clone(record.receivables),
    subscriptions: [],
  });
}

export async function mockUpdateContract(
  contractId: string,
  body: ContractUpdateInput,
): Promise<{ contract: ContractEntity }> {
  const record = findRecord(contractId);
  if (body.version !== record.contract.version) {
    throw conflict('合同已被他人修改，请刷新后重试');
  }
  if (
    record.contract.status !== 'draft' &&
    record.contract.status !== 'reviewing'
  ) {
    throw stateConflict(
      '合同已生效或已终结，不能直接修改，请走变更单',
      'CONTRACT_IMMUTABLE',
    );
  }
  const items = body.items ? buildItems(body.items) : record.items;
  record.items = items;
  record.contract = {
    ...record.contract,
    businessNote: body.businessNote ?? record.contract.businessNote,
    effectiveOn: body.effectiveOn ?? record.contract.effectiveOn,
    expiresOn: body.expiresOn ?? record.contract.expiresOn,
    paymentTerms: body.paymentTerms ?? record.contract.paymentTerms,
    taxNote: body.taxNote ?? record.contract.taxNote,
    totalAmount: sumAmount(items),
    updatedAt: new Date().toISOString(),
    version: record.contract.version + 1,
  };
  return delay({ contract: clone(record.contract) });
}

const TRANSITION_TARGET: Partial<
  Record<ContractTransitionAction, ContractStatus>
> = {
  activate: 'active',
  expire: 'expired',
  sign: 'signed',
  submit: 'reviewing',
  terminate: 'terminated',
  withdraw: 'draft',
};

export async function mockTransitionContract(
  contractId: string,
  body: ContractTransitionInput,
): Promise<ContractTransitionResult> {
  const record = findRecord(contractId);
  if (body.version !== record.contract.version) {
    throw conflict('合同已被他人修改，请刷新后重试');
  }
  if (!ALLOWED_ACTIONS[record.contract.status].includes(body.action)) {
    throw stateConflict(
      `当前状态（${record.contract.status}）不允许执行该操作`,
    );
  }
  if (body.action === 'submit' && record.items.length === 0) {
    throw stateConflict('合同至少需要一条条目才能提交');
  }
  if (body.action === 'sign') {
    if (!body.signedOn) {
      throw validation('签署需要填写签约日期');
    }
    record.contract.signedOn = body.signedOn;
  }
  if (body.action === 'activate' && !body.effectiveOn) {
    throw validation('生效需要填写生效日期');
  }
  if (body.action === 'terminate') {
    if (!body.reason?.trim()) {
      throw validation('终止必须填写原因');
    }
    if (body.confirmImpact !== true) {
      throw validation('终止必须确认影响摘要');
    }
  }

  const target = TRANSITION_TARGET[body.action];
  if (!target) {
    throw validation('不支持的状态迁移动作');
  }

  record.contract.status = target;
  record.contract.version += 1;
  record.contract.updatedAt = new Date().toISOString();
  if (body.action === 'activate') {
    record.contract.effectiveOn =
      body.effectiveOn ?? record.contract.effectiveOn;
    record.contract.currentVersionNo += 1;
    // 生效写快照：历史版本不改写，只追加（契约 §3.3）
    record.versions.push({
      changeReason: body.reason ?? '合同生效',
      createdAt: record.contract.updatedAt,
      createdBy: '示例运营（桩）',
      snapshotSummary: {
        currency: record.contract.currency,
        effectiveOn: record.contract.effectiveOn,
        expiresOn: record.contract.expiresOn,
        itemCount: record.items.length,
        totalAmount: record.contract.totalAmount,
      },
      versionNo: record.contract.currentVersionNo,
    });
  }
  if (body.action === 'terminate') {
    record.contract.statusReason = body.reason ?? null;
  }

  return delay({
    contract: {
      status: record.contract.status,
      version: record.contract.version,
    },
    createdVersionNo:
      body.action === 'activate' ? record.contract.currentVersionNo : undefined,
    impact:
      body.action === 'terminate'
        ? {
            entitlements: 0,
            receivables: record.receivables.length,
            tenantCommands: 0,
          }
        : undefined,
  });
}

export async function mockFetchContractVersions(
  contractId: string,
): Promise<{ items: ContractVersionEntry[] }> {
  const record = findRecord(contractId);
  const items = record.versions.toSorted(
    (left, right) => right.versionNo - left.versionNo,
  );
  return delay({ items: clone(items) });
}

export async function mockFetchContractEntitlementPreview(
  contractId: string,
): Promise<ContractEntitlementPreview> {
  const record = findRecord(contractId);
  return delay({
    features: buildEntitlementFeatures(record.items),
    warnings: record.items.some((item) => item.termMonths === null)
      ? ['示例提醒：存在无期限条目，请确认是否为一次性授权']
      : [],
  });
}

export async function mockCreateContractRenewal(
  contractId: string,
  body: ContractRenewalInput,
): Promise<ContractRenewalResult> {
  const record = findRecord(contractId);
  if (!body.reason?.trim()) {
    throw validation('续约必须填写原因');
  }
  if (!(body.expiresOn >= body.effectiveOn)) {
    throw validation('到期日不得早于生效日');
  }
  const expiresOn = record.contract.expiresOn;
  const isDue =
    record.contract.status === 'expired' ||
    record.contract.status === 'terminated' ||
    (expiresOn !== null &&
      new Date(expiresOn).getTime() - Date.now() <=
        RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (!isDue) {
    throw stateConflict(
      `原合同尚未到期（到期日 ${expiresOn ?? '未设置'}），续约需要显式强制确认`,
      'RENEWAL_NOT_DUE',
    );
  }

  contractSequence += 1;
  const now = new Date().toISOString();
  const items = buildItems(body.items);
  const entity: ContractEntity = {
    businessNote: `由 ${record.contract.contractNo} 续约（示例）`,
    contractNo: `HT-2026-${String(contractSequence).padStart(6, '0')}`,
    createdAt: now,
    currency: record.contract.currency,
    currentVersionNo: 1,
    customer: record.contract.customer,
    effectiveOn: body.effectiveOn,
    expiresOn: body.expiresOn,
    id: `con-${String(contractSequence).padStart(4, '0')}`,
    paymentTerms: record.contract.paymentTerms,
    renewedFromContractId: record.contract.id,
    salesMode: record.contract.salesMode,
    salesOwner: record.contract.salesOwner,
    signedOn: null,
    status: 'draft',
    statusReason: null,
    taxNote: record.contract.taxNote,
    totalAmount: sumAmount(items),
    updatedAt: now,
    version: 1,
  };
  store.unshift({
    attachments: [],
    contract: entity,
    items,
    receivables: [],
    versions: [],
  });
  return delay({
    contract: {
      contractNo: entity.contractNo,
      id: entity.id,
      renewedFromContractId: entity.renewedFromContractId,
    },
  });
}

export async function mockFetchContractAttachments(
  contractId: string,
): Promise<{ items: ContractAttachment[] }> {
  const record = findRecord(contractId);
  return delay({ items: clone(record.attachments) });
}

export async function mockCreateContractAttachment(
  contractId: string,
  body: { byteSize: number; contentType: string; fileName: string },
): Promise<{
  attachment: ContractAttachment;
  uploadExpiresAt: string;
  uploadUrl: string;
}> {
  const record = findRecord(contractId);
  if (!(body.byteSize > 0 && body.byteSize <= 26_214_400)) {
    throw validation('附件大小必须在 1 字节到 25 MiB 之间');
  }
  attachmentSequence += 1;
  const attachment: ContractAttachment = {
    byteSize: body.byteSize,
    contentType: body.contentType,
    fileName: body.fileName,
    id: `att-${String(attachmentSequence).padStart(4, '0')}`,
    status: 'pending',
    uploadedAt: new Date().toISOString(),
    uploadedBy: '示例运营（桩）',
  };
  record.attachments.push(attachment);
  return delay({
    attachment: clone(attachment),
    // 桩不提供真实存储：返回不可用的占位地址，禁止据此上传
    uploadExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    uploadUrl: 'about:blank#stub-storage-not-connected',
  });
}

export async function mockFetchContractAttachmentAccess(
  attachmentId: string,
): Promise<{ expiresAt: string; url: string }> {
  return delay({
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    url: `about:blank#stub-attachment-${encodeURIComponent(attachmentId)}`,
  });
}
