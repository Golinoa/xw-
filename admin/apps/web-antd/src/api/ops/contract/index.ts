/**
 * 合同、条目、版本、附件与续约（contract 域）API 客户端。
 *
 * 契约真源：`Docs/ops-api-contract.md` §5.4（端点）、§3.3（数据模型与状态机）、§2.5（幂等）。
 *
 * 约束：
 * - 合同金额由条目复算，请求体**不提交**合计字段（契约 §2.2、§3.3）；
 * - `active`/`expired`/`terminated` 禁止 `PATCH`，只能走变更单（契约 §3.3 核心规则）；
 * - 状态只能经 `/transition` 修改；`sign`/`activate`/`terminate`/`expire` 属高风险动作
 *   `contract.approve`，写请求必须带 `Idempotency-Key`（契约 §2.5 必填范围）。
 */
import { getOpsEnv } from '#/api/adapter/env';
import { requestClient } from '#/api/request';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

/** 端点清单：路径只从这里取。附件完成/访问端点不带合同 ID（契约 §5.4 原文）。 */
export const CONTRACT_ENDPOINTS = {
  list: `${OPS_API_PREFIX}/contracts`,
  detail: (contractId: string) =>
    `${OPS_API_PREFIX}/contracts/${encodeURIComponent(contractId)}`,
  transition: (contractId: string) =>
    `${OPS_API_PREFIX}/contracts/${encodeURIComponent(contractId)}/transition`,
  versions: (contractId: string) =>
    `${OPS_API_PREFIX}/contracts/${encodeURIComponent(contractId)}/versions`,
  amendments: (contractId: string) =>
    `${OPS_API_PREFIX}/contracts/${encodeURIComponent(contractId)}/amendments`,
  amendmentTransition: (contractId: string, amendmentId: string) =>
    `${OPS_API_PREFIX}/contracts/${encodeURIComponent(contractId)}/amendments/${encodeURIComponent(amendmentId)}/transition`,
  renewals: (contractId: string) =>
    `${OPS_API_PREFIX}/contracts/${encodeURIComponent(contractId)}/renewals`,
  entitlementPreview: (contractId: string) =>
    `${OPS_API_PREFIX}/contracts/${encodeURIComponent(contractId)}/entitlement-preview`,
  attachments: (contractId: string) =>
    `${OPS_API_PREFIX}/contracts/${encodeURIComponent(contractId)}/attachments`,
  attachmentComplete: (attachmentId: string) =>
    `${OPS_API_PREFIX}/contract-attachments/${encodeURIComponent(attachmentId)}/complete`,
  attachmentAccess: (attachmentId: string) =>
    `${OPS_API_PREFIX}/contract-attachments/${encodeURIComponent(attachmentId)}/access`,
} as const;

/** 合同状态，契约 §3.3 状态机 + PRD §8。 */
export type ContractStatus =
  | 'active'
  | 'draft'
  | 'expired'
  | 'reviewing'
  | 'signed'
  | 'terminated';

/** 合同状态迁移动作，契约 §5.4 `POST /contracts/{id}/transition`。 */
export type ContractTransitionAction =
  | 'activate'
  | 'expire'
  | 'sign'
  | 'submit'
  | 'terminate'
  | 'withdraw';

/** 销售方式（`saas`/`private`），与 catalog 域同一词表（契约 §3.2）。 */
export type ContractSalesMode = 'private' | 'saas';

/** 计费类型，契约 §3.2 `packages.billing_type`。 */
export type ContractBillingType = 'fixed_term' | 'one_time' | 'periodic';

export interface OpsOperatorRef {
  id: string;
  displayName: string;
}

/** 列表条目，契约 §5.4 `GET /contracts` → `items[]`。 */
export interface ContractListItem {
  id: string;
  contractNo: string;
  customer: { id: string; name: string };
  status: ContractStatus;
  salesMode: ContractSalesMode;
  totalAmount: number;
  currency: string;
  effectiveOn: null | string;
  expiresOn: null | string;
  receivableSummary: null | {
    outstanding: number;
    settled: number;
    total: number;
  };
}

export interface ContractListQuery {
  keyword?: string;
  customerId?: string;
  status?: ContractStatus[];
  salesOwnerOperatorId?: string;
  expiresFrom?: string;
  expiresTo?: string;
  salesMode?: ContractSalesMode;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface ContractPage {
  items: ContractListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 合同头（契约 §3.3 `ops.contracts` 的对外可见列）。 */
export interface ContractEntity {
  id: string;
  contractNo: string;
  customer: { id: string; name: string };
  salesOwner: null | OpsOperatorRef;
  salesMode: ContractSalesMode;
  currency: string;
  totalAmount: number;
  paymentTerms: null | string;
  taxNote: null | string;
  businessNote: null | string;
  status: ContractStatus;
  signedOn: null | string;
  effectiveOn: null | string;
  expiresOn: null | string;
  renewedFromContractId: null | string;
  statusReason: null | string;
  currentVersionNo: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 合同条目，契约 §3.3 `ops.contract_items`（`amount` 由服务端复算）。 */
export interface ContractItem {
  id: string;
  productId: null | string;
  packageId: null | string;
  packagePriceVersionId: null | string;
  salesMode: ContractSalesMode;
  billingType: ContractBillingType;
  quantity: number;
  unitPrice: number;
  amount: number;
  termMonths: null | number;
  itemNameSnapshot: string;
}

/** 详情里的应收/订阅/授权摘要（契约 §5.4 未逐字段定义，取最小可见字段）。 */
export interface ContractReceivableRow {
  id: string;
  periodNo: number;
  dueDate: string;
  amount: number;
  outstanding: number;
  currency: string;
  status: string;
}

export interface ContractSubscriptionRow {
  id: string;
  subscriptionNo: string;
  status: string;
  startsOn: null | string;
  endsOn: null | string;
}

export interface ContractLicenseRow {
  id: string;
  licenseNo: string;
  status: string;
  validFrom: null | string;
  validTo: null | string;
}

/** 附件元数据，契约 §3.3 `ops.contract_attachments`（不存文件本体，只存安全访问引用）。 */
export interface ContractAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  uploadedBy: null | string;
  uploadedAt: string;
  status?: 'pending' | 'stored';
}

/** 详情响应，契约 §5.4 `GET /contracts/{contractId}`。 */
export interface ContractDetail {
  contract: ContractEntity;
  items: ContractItem[];
  receivables: ContractReceivableRow[];
  subscriptions: ContractSubscriptionRow[];
  licenses: ContractLicenseRow[];
  attachments: ContractAttachment[];
  allowedActions: ContractTransitionAction[];
}

/**
 * 版本快照摘要。
 *
 * [推导] 契约 §5.4 只给出 `snapshotSummary` 字段名，未定义内部结构；
 * 这里按「版本列表需要展示的合同头摘要」取可选字段，缺字段时不渲染。
 */
export interface ContractVersionSnapshotSummary {
  totalAmount?: number;
  currency?: string;
  itemCount?: number;
  effectiveOn?: null | string;
  expiresOn?: null | string;
}

export interface ContractVersionEntry {
  versionNo: number;
  snapshotSummary: ContractVersionSnapshotSummary | null;
  changeReason: string;
  createdBy: null | string;
  createdAt: string;
}

export interface ContractVersionList {
  items: ContractVersionEntry[];
}

/** 权益预览，契约 §5.4 `GET /contracts/{id}/entitlement-preview`。 */
export interface ContractEntitlementPreview {
  features: {
    appliesTo: string;
    displayName: string;
    enabled: boolean;
    featureKey: string;
    quota: null | number;
    termMonths: null | number;
  }[];
  warnings: string[];
}

export interface ContractItemInput {
  productId: string;
  packageId: string;
  priceVersionId: string;
  quantity: number;
  unitPrice: number;
  termMonths?: number;
}

/** 草拟入参，契约 §5.4 `POST /contracts`（不提交合计）。 */
export interface ContractCreateInput {
  customerId: string;
  salesMode: ContractSalesMode;
  currency: string;
  paymentTerms?: string;
  taxNote?: string;
  businessNote?: string;
  items: ContractItemInput[];
}

export interface ContractCreateResult {
  contract: ContractEntity;
  items: ContractItem[];
  entitlementPreview: ContractEntitlementPreview['features'];
}

export interface ContractUpdateInput {
  paymentTerms?: string;
  taxNote?: string;
  businessNote?: string;
  effectiveOn?: string;
  expiresOn?: string;
  items?: ContractItemInput[];
  version: number;
}

/** 状态迁移入参。高风险动作需 `reason`，终止类还需 `confirmImpact=true`。 */
export interface ContractTransitionInput {
  action: ContractTransitionAction;
  reason?: string;
  signedOn?: string;
  effectiveOn?: string;
  confirmImpact?: boolean;
  version: number;
}

export interface ContractTransitionResult {
  contract: { status: ContractStatus; version: number };
  impact?: {
    entitlements: number;
    receivables: number;
    tenantCommands: number;
  };
  createdVersionNo?: number;
}

export interface ContractRenewalInput {
  effectiveOn: string;
  expiresOn: string;
  items: ContractItemInput[];
  reason: string;
}

export interface ContractRenewalResult {
  contract: {
    contractNo: string;
    id: string;
    renewedFromContractId: null | string;
  };
}

/**
 * 幂等键（契约 §2.5）。
 *
 * 一次用户动作生成一个键；适配层内部重试复用同一请求配置，因此键不变。
 * 生产环境走 `crypto.randomUUID`（需要安全上下文），非安全上下文退化为
 * 随机串（仍满足 8–128 位 `[A-Za-z0-9_-]`）。
 */
export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 12);
  return `ops-${Date.now().toString(36)}-${random}`;
}

function idempotentConfig(): { headers: Record<string, string> } {
  return { headers: { 'Idempotency-Key': createIdempotencyKey() } };
}

export async function fetchContracts(
  query: ContractListQuery = {},
): Promise<ContractPage> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchContracts } = await import('./mock');
    return mockFetchContracts(query);
  }
  return requestClient.get<ContractPage>(CONTRACT_ENDPOINTS.list, {
    params: query,
  });
}

/** 草拟合同。409 `CONFLICT` = 合同编号冲突，调用方必须保留用户输入。 */
export async function createContract(
  body: ContractCreateInput,
): Promise<ContractCreateResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreateContract } = await import('./mock');
    return mockCreateContract(body);
  }
  return requestClient.post<ContractCreateResult>(
    CONTRACT_ENDPOINTS.list,
    body,
    idempotentConfig(),
  );
}

export async function fetchContract(
  contractId: string,
): Promise<ContractDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchContract } = await import('./mock');
    return mockFetchContract(contractId);
  }
  return requestClient.get<ContractDetail>(
    CONTRACT_ENDPOINTS.detail(contractId),
  );
}

/** 编辑合同头/条目（仅 `draft`/`reviewing`；否则 409 `CONTRACT_IMMUTABLE`）。 */
export async function updateContract(
  contractId: string,
  body: ContractUpdateInput,
): Promise<{ contract: ContractEntity }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockUpdateContract } = await import('./mock');
    return mockUpdateContract(contractId, body);
  }
  return requestClient.request<{ contract: ContractEntity }>(
    CONTRACT_ENDPOINTS.detail(contractId),
    { data: body, method: 'PATCH', headers: idempotentConfig().headers },
  );
}

/**
 * 状态迁移。
 *
 * `sign`/`activate`/`terminate`/`expire` 需要 `contract.approve`；
 * 终止请求应带 `confirmImpact=true`（契约 §3.3），原因由调用方在确认弹窗中收集。
 */
export async function transitionContract(
  contractId: string,
  body: ContractTransitionInput,
): Promise<ContractTransitionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockTransitionContract } = await import('./mock');
    return mockTransitionContract(contractId, body);
  }
  return requestClient.post<ContractTransitionResult>(
    CONTRACT_ENDPOINTS.transition(contractId),
    body,
    idempotentConfig(),
  );
}

export async function fetchContractVersions(
  contractId: string,
): Promise<ContractVersionList> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchContractVersions } = await import('./mock');
    return mockFetchContractVersions(contractId);
  }
  return requestClient.get<ContractVersionList>(
    CONTRACT_ENDPOINTS.versions(contractId),
  );
}

export async function fetchContractEntitlementPreview(
  contractId: string,
): Promise<ContractEntitlementPreview> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchContractEntitlementPreview } = await import('./mock');
    return mockFetchContractEntitlementPreview(contractId);
  }
  return requestClient.get<ContractEntitlementPreview>(
    CONTRACT_ENDPOINTS.entitlementPreview(contractId),
  );
}

/** 续约：新建合同并写 `renewedFromContractId`，不改写原合同（契约 §3.3）。 */
export async function createContractRenewal(
  contractId: string,
  body: ContractRenewalInput,
): Promise<ContractRenewalResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreateContractRenewal } = await import('./mock');
    return mockCreateContractRenewal(contractId, body);
  }
  return requestClient.post<ContractRenewalResult>(
    CONTRACT_ENDPOINTS.renewals(contractId),
    body,
    idempotentConfig(),
  );
}

export async function fetchContractAttachments(
  contractId: string,
): Promise<{ items: ContractAttachment[] }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchContractAttachments } = await import('./mock');
    return mockFetchContractAttachments(contractId);
  }
  return requestClient.get<{ items: ContractAttachment[] }>(
    CONTRACT_ENDPOINTS.attachments(contractId),
  );
}

/**
 * 申请附件上传（两段式：先签发 ≤5 分钟上传 URL，再 `complete`）。
 *
 * 首期页面只读取附件列表；上传入口在存储契约（契约 §11 U-13）落地前不开放，
 * 这里保留请求函数供后续接入，避免页面自行拼 URL。
 */
export async function createContractAttachment(
  contractId: string,
  body: { byteSize: number; contentType: string; fileName: string },
): Promise<{
  attachment: ContractAttachment;
  uploadExpiresAt: string;
  uploadUrl: string;
}> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreateContractAttachment } = await import('./mock');
    return mockCreateContractAttachment(contractId, body);
  }
  return requestClient.post<{
    attachment: ContractAttachment;
    uploadExpiresAt: string;
    uploadUrl: string;
  }>(CONTRACT_ENDPOINTS.attachments(contractId), body, idempotentConfig());
}

/** 附件下载地址（≤5 分钟签名 URL，禁止在前端缓存）。 */
export async function fetchContractAttachmentAccess(
  attachmentId: string,
): Promise<{ expiresAt: string; url: string }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchContractAttachmentAccess } = await import('./mock');
    return mockFetchContractAttachmentAccess(attachmentId);
  }
  return requestClient.get<{ expiresAt: string; url: string }>(
    CONTRACT_ENDPOINTS.attachmentAccess(attachmentId),
  );
}
