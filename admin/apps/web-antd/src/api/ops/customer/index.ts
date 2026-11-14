/**
 * 客户与联系人（customer 域）API 客户端。
 *
 * 契约真源：`Docs/ops-api-contract.md` §5.2（端点）、§3.1（数据模型与状态机）、
 * §6（错误码）。字段名逐字对齐契约，**不得自行改名**；契约未定义的字段不在这里虚构。
 *
 * 本文件只做「路径 + 参数 + 类型 + 调用 request 客户端」：
 * - 不处理 UI 提示、不跳转、不做业务判断；
 * - 分页/筛选/排序一律走服务端参数（`page`/`pageSize`/`sort`/`order`），
 *   禁止全量拉取后在浏览器过滤；
 * - 开发态（`VITE_OPS_MOCK=true`）走 `./mock` 的虚构数据，并在页面上显式标注。
 */
import { getOpsEnv } from '#/api/adapter/env';
import { requestClient } from '#/api/request';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

/** 端点清单：所有路径只能从这里取，避免契约前缀调整时漏改。 */
export const CUSTOMER_ENDPOINTS = {
  list: `${OPS_API_PREFIX}/customers`,
  duplicateCheck: `${OPS_API_PREFIX}/customers/duplicate-check`,
  detail: (customerId: string) =>
    `${OPS_API_PREFIX}/customers/${encodeURIComponent(customerId)}`,
  transition: (customerId: string) =>
    `${OPS_API_PREFIX}/customers/${encodeURIComponent(customerId)}/transition`,
  overview: (customerId: string) =>
    `${OPS_API_PREFIX}/customers/${encodeURIComponent(customerId)}/overview`,
  contacts: (customerId: string) =>
    `${OPS_API_PREFIX}/customers/${encodeURIComponent(customerId)}/contacts`,
  contact: (customerId: string, contactId: string) =>
    `${OPS_API_PREFIX}/customers/${encodeURIComponent(customerId)}/contacts/${encodeURIComponent(contactId)}`,
} as const;

/** 客户生命周期状态，契约 §3.1 状态机 + PRD §8。终态为 `terminated`，无物理删除。 */
export type CustomerStatus =
  | 'active'
  | 'onboarding'
  | 'signed'
  | 'suspended'
  | 'terminated';

/** 客户状态迁移动作，契约 §5.2 `POST /customers/{id}/transition`。 */
export type CustomerTransitionAction =
  | 'activate'
  | 'resume'
  | 'start_onboarding'
  | 'suspend'
  | 'terminate';

/** 销售方式，契约 §3.2 `ops.product_sales_modes.sales_mode`。 */
export type SalesMode = 'private' | 'saas';

/** 排序字段白名单，契约 §5.2 `GET /customers`（其它字段服务端应拒绝）。 */
export type CustomerSortField = 'createdAt' | 'name' | 'updatedAt';

export type SortOrder = 'asc' | 'desc';

/** 分页 `pageSize` 白名单，契约 §2.4 引用 `listQuerySchema`。 */
export const OPS_PAGE_SIZE_OPTIONS = [10, 15, 20, 30, 50, 100] as const;

/** 默认分页大小，契约 §2.4（默认 15，上限见白名单）。 */
export const OPS_DEFAULT_PAGE_SIZE = 15;

/** 运营成员引用（`owner` / `salesOwner` 等字段），契约 §5 各域统一形状。 */
export interface OpsOperatorRef {
  id: string;
  displayName: string;
}

/** 列表条目，契约 §5.2 `GET /customers` → `items[]`。 */
export interface CustomerListItem {
  id: string;
  customerNo: string;
  name: string;
  status: CustomerStatus;
  owner: null | OpsOperatorRef;
  primaryContact: null | {
    maskedEmail: null | string;
    maskedPhone: null | string;
  };
  activeContractCount: number;
  createdAt: string;
}

/** 列表查询参数，契约 §5.2 `GET /customers` 的请求关键字段 + 通用分页参数。 */
export interface CustomerListQuery {
  keyword?: string;
  status?: CustomerStatus[];
  ownerOperatorId?: string;
  contractStatus?: string;
  entitlementExpiringInDays?: number;
  page?: number;
  pageSize?: number;
  sort?: CustomerSortField;
  order?: SortOrder;
}

/** 列表响应，契约 §2.4 `{ items, total, page, pageSize }`。 */
export interface CustomerPage {
  items: CustomerListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 联系人。
 *
 * `phoneMasked`/`emailMasked` 来自契约 §5.2 `GET /customers/{id}/contacts`；
 * `phone`/`email` 原值仅在后端判定具备 `customer.sensitive.read` 时下发，
 * 前端**不得**自行拼接或反推原值。
 */
export interface CustomerContact {
  id: string;
  name: string;
  jobTitle: null | string;
  phoneMasked: null | string;
  emailMasked: null | string;
  phone?: null | string;
  email?: null | string;
  isPrimary: boolean;
  usageScene: null | string;
  version: number;
}

/** 客户聚合（契约 §3.1 `ops.customers` 的对外可见列）。 */
export interface Customer {
  id: string;
  customerNo: string;
  name: string;
  unifiedSocialCreditCode: null | string;
  regionCode: null | string;
  status: CustomerStatus;
  owner: null | OpsOperatorRef;
  sourceNote: null | string;
  internalNote: null | string;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: null | string;
  archiveReason: null | string;
}

/** 详情响应，契约 §5.2 `GET /customers/{customerId}`。 */
export interface CustomerDetail {
  customer: Customer;
  contacts: CustomerContact[];
  counts: {
    contracts: number;
    deployments: number;
    licenses: number;
    receivables: number;
    subscriptions: number;
    tickets: number;
  };
}

/** 新建客户入参，契约 §5.2 `POST /customers`（请求体只接受明细字段，不接受合计）。 */
export interface CustomerCreateInput {
  name: string;
  unifiedSocialCreditCode?: string;
  regionCode?: string;
  sourceNote?: string;
  internalNote?: string;
  ownerOperatorId?: string;
  contacts?: CustomerContactInput[];
}

/** 联系人写入字段，契约 §5.2 `POST|PATCH /customers/{id}/contacts`。 */
export interface CustomerContactInput {
  name: string;
  jobTitle?: string;
  phone?: string;
  email?: string;
  isPrimary?: boolean;
  usageScene?: string;
}

/** 新建响应：`duplicateHints` 是「重复提示，不自动合并」，PRD §6.2。 */
export interface CustomerCreateResult {
  customer: Customer;
  duplicateHints: {
    customerNo: string;
    id: string;
    name: string;
    reason: string;
  }[];
}

/** 重复检查响应，契约 §5.2 `POST /customers/duplicate-check`。 */
export interface CustomerDuplicateCheckResult {
  items: {
    customerNo: string;
    id: string;
    matchReason: string;
    name: string;
  }[];
}

/** 编辑入参，契约 §5.2 `PATCH /customers/{customerId}`（`status` 不在可编辑字段内）。 */
export interface CustomerUpdateInput {
  name?: string;
  unifiedSocialCreditCode?: string;
  regionCode?: string;
  sourceNote?: string;
  internalNote?: string;
  ownerOperatorId?: string;
  version: number;
}

/** 状态迁移入参，契约 §5.2（`suspend`/`resume`/`terminate` 需要 `reason`）。 */
export interface CustomerTransitionInput {
  action: CustomerTransitionAction;
  reason: string;
  version: number;
}

/** 状态迁移响应：`impact` 供前端在二次确认里展示影响摘要（契约 §5.2）。 */
export interface CustomerTransitionResult {
  customer: {
    status: CustomerStatus;
    version: number;
  };
  impact?: {
    contracts: number;
    deployments: number;
    entitlements: number;
    tickets: number;
  };
}

/** 概览摘要数组的具体形状契约未定义，沿用各域列表条目的最小可见字段。 */
export interface CustomerOverview {
  contracts: {
    contractNo: string;
    currency: string;
    id: string;
    status: string;
    totalAmount: number;
  }[];
  receivables: {
    amount: number;
    contractId: string;
    currency: string;
    dueDate: string;
    id: string;
    outstanding: number;
    status: string;
  }[];
  subscriptions: {
    endsOn: null | string;
    id: string;
    status: string;
    subscriptionNo: string;
  }[];
  licenses: {
    id: string;
    licenseNo: string;
    status: string;
    validTo: null | string;
  }[];
  tenantMappings: {
    id: string;
    lastSyncedAt: null | string;
    mappingNo: string;
    mappingStatus: string;
  }[];
  deployments: {
    id: string;
    instanceNo: string;
    name: string;
    status: string;
  }[];
  tickets: {
    id: string;
    status: string;
    subject: string;
    ticketNo: string;
  }[];
}

export interface CustomerContactList {
  items: CustomerContact[];
}

/** 客户列表（服务端分页/筛选/排序）。 */
export async function fetchCustomers(
  query: CustomerListQuery = {},
): Promise<CustomerPage> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchCustomers } = await import('./mock');
    return mockFetchCustomers(query);
  }
  return requestClient.get<CustomerPage>(CUSTOMER_ENDPOINTS.list, {
    params: query,
  });
}

/** 新建客户。409 `CONFLICT` 表示编号/唯一约束冲突，调用方必须保留用户输入。 */
export async function createCustomer(
  body: CustomerCreateInput,
): Promise<CustomerCreateResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreateCustomer } = await import('./mock');
    return mockCreateCustomer(body);
  }
  return requestClient.post<CustomerCreateResult>(
    CUSTOMER_ENDPOINTS.list,
    body,
  );
}

/** 重复提示查询（名称/统一社会信用代码），PRD §6.2「用于重复提示，不自动合并」。 */
export async function checkCustomerDuplicates(body: {
  name: string;
  unifiedSocialCreditCode?: string;
}): Promise<CustomerDuplicateCheckResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCheckCustomerDuplicates } = await import('./mock');
    return mockCheckCustomerDuplicates(body);
  }
  return requestClient.post<CustomerDuplicateCheckResult>(
    CUSTOMER_ENDPOINTS.duplicateCheck,
    body,
  );
}

/** 客户详情（含联系人、关联计数）。 */
export async function fetchCustomer(
  customerId: string,
): Promise<CustomerDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchCustomer } = await import('./mock');
    return mockFetchCustomer(customerId);
  }
  return requestClient.get<CustomerDetail>(
    CUSTOMER_ENDPOINTS.detail(customerId),
  );
}

/** 编辑客户。409 `CONFLICT` 表示 `version` 与库中不一致（契约 §3.0 乐观锁）。 */
export async function updateCustomer(
  customerId: string,
  body: CustomerUpdateInput,
): Promise<{ customer: Customer }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockUpdateCustomer } = await import('./mock');
    return mockUpdateCustomer(customerId, body);
  }
  return requestClient.request<{ customer: Customer }>(
    CUSTOMER_ENDPOINTS.detail(customerId),
    { data: body, method: 'PATCH' },
  );
}

/** 状态迁移。状态只能走本端点修改，禁止用 `PATCH` 改 `status`（契约 §3.1）。 */
export async function transitionCustomer(
  customerId: string,
  body: CustomerTransitionInput,
): Promise<CustomerTransitionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockTransitionCustomer } = await import('./mock');
    return mockTransitionCustomer(customerId, body);
  }
  return requestClient.post<CustomerTransitionResult>(
    CUSTOMER_ENDPOINTS.transition(customerId),
    body,
  );
}

/** 客户关联概览（合同/应收/订阅/授权/租户/部署/工单摘要）。 */
export async function fetchCustomerOverview(
  customerId: string,
): Promise<CustomerOverview> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchCustomerOverview } = await import('./mock');
    return mockFetchCustomerOverview(customerId);
  }
  return requestClient.get<CustomerOverview>(
    CUSTOMER_ENDPOINTS.overview(customerId),
  );
}

/** 联系人列表（联系方式按权限掩码，见 `CustomerContact`）。 */
export async function fetchCustomerContacts(
  customerId: string,
): Promise<CustomerContactList> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchCustomerContacts } = await import('./mock');
    return mockFetchCustomerContacts(customerId);
  }
  return requestClient.get<CustomerContactList>(
    CUSTOMER_ENDPOINTS.contacts(customerId),
  );
}

/** 新增联系人。主要联系人冲突由服务端自动降级旧主要联系人（契约 §5.2）。 */
export async function createCustomerContact(
  customerId: string,
  body: CustomerContactInput,
): Promise<{ contact: CustomerContact }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreateCustomerContact } = await import('./mock');
    return mockCreateCustomerContact(customerId, body);
  }
  return requestClient.post<{ contact: CustomerContact }>(
    CUSTOMER_ENDPOINTS.contacts(customerId),
    body,
  );
}

/** 编辑联系人。 */
export async function updateCustomerContact(
  customerId: string,
  contactId: string,
  body: CustomerContactInput & { version: number },
): Promise<{ contact: CustomerContact }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockUpdateCustomerContact } = await import('./mock');
    return mockUpdateCustomerContact(customerId, contactId, body);
  }
  return requestClient.request<{ contact: CustomerContact }>(
    CUSTOMER_ENDPOINTS.contact(customerId, contactId),
    { data: body, method: 'PATCH' },
  );
}

/** 删除联系人。409 `STATE_CONFLICT` = 唯一主要联系人且客户未终止（契约 §5.2）。 */
export async function deleteCustomerContact(
  customerId: string,
  contactId: string,
): Promise<{ deletedContactId: string }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockDeleteCustomerContact } = await import('./mock');
    return mockDeleteCustomerContact(customerId, contactId);
  }
  return requestClient.delete<{ deletedContactId: string }>(
    CUSTOMER_ENDPOINTS.contact(customerId, contactId),
  );
}
