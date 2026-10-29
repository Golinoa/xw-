import type { FixtureCustomerRecord } from './fixtures';
import type {
  Customer,
  CustomerContact,
  CustomerContactInput,
  CustomerContactList,
  CustomerCreateInput,
  CustomerCreateResult,
  CustomerDetail,
  CustomerDuplicateCheckResult,
  CustomerListQuery,
  CustomerOverview,
  CustomerPage,
  CustomerStatus,
  CustomerTransitionInput,
  CustomerTransitionResult,
  CustomerUpdateInput,
} from './index';

/**
 * customer 域开发态桩（仅 `VITE_OPS_MOCK=true`）。
 *
 * 作用：后端 ops API 尚未实现时，让客户列表/详情/迁移流程可运行可演示。
 * 它不是 mock 服务、不代表后端已集成；数据全部来自 `./fixtures`（虚构）。
 *
 * 桩**不模拟权限裁剪**：联系方式原值一并返回，页面是否展示由
 * `useOpsPermission()` + `customer.sensitive.read` 决定；真实后端会按动作码
 * 直接不下发 `phone`/`email`。该差异在 `README.md` 的「待后端确认」登记。
 */
import { OpsApiError } from '#/api/adapter/errors';

import { FIXTURE_CUSTOMERS } from './fixtures';

const STUB_LATENCY_MS = 60;

interface ContactWithSecret extends CustomerContact {
  phone: null | string;
  email: null | string;
}

interface StoreRecord {
  customer: Customer;
  contacts: ContactWithSecret[];
  counts: FixtureCustomerRecord['counts'];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), STUB_LATENCY_MS);
  });
}

/** 模块级内存表：刷新页面即恢复初始虚构数据。 */
const store: StoreRecord[] = clone(FIXTURE_CUSTOMERS).map((record) => ({
  ...record,
  contacts: record.contacts.map((item) => ({
    ...item,
    phone: item.phone ?? null,
    email: item.email ?? null,
  })),
}));

let customerSequence = 9;
let contactSequence = 9;

function conflict(message: string, reason?: string): OpsApiError {
  return new OpsApiError({
    code: 'CONFLICT',
    details: reason ? { reason } : undefined,
    kind: 'http',
    reason,
    retryable: false,
    status: 409,
    userMessage: message,
  });
}

function stateConflict(
  message: string,
  allowedActions: string[] = [],
): OpsApiError {
  return new OpsApiError({
    code: 'STATE_CONFLICT',
    details: { allowedActions },
    kind: 'http',
    retryable: false,
    status: 409,
    userMessage: message,
  });
}

function notFound(): OpsApiError {
  return new OpsApiError({
    code: 'NOT_FOUND',
    kind: 'http',
    retryable: false,
    status: 404,
    userMessage: '客户不存在或已被移除',
  });
}

function findRecord(customerId: string): StoreRecord {
  const record = store.find((item) => item.customer.id === customerId);
  if (!record) {
    throw notFound();
  }
  return record;
}

function toListItem(record: StoreRecord) {
  const primary = record.contacts.find((item) => item.isPrimary);
  return {
    activeContractCount: record.counts.contracts,
    createdAt: record.customer.createdAt,
    customerNo: record.customer.customerNo,
    id: record.customer.id,
    name: record.customer.name,
    owner: record.customer.owner,
    primaryContact: primary
      ? { maskedEmail: primary.emailMasked, maskedPhone: primary.phoneMasked }
      : null,
    status: record.customer.status,
  };
}

function mask(
  value: null | string,
  keepStart: number,
  keepEnd: number,
): null | string {
  if (!value) {
    return value;
  }
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${value.slice(0, keepStart)}****${value.slice(-keepEnd)}`;
}

function toContact(source: ContactWithSecret): CustomerContact {
  return {
    email: source.email,
    emailMasked: mask(source.email, 1, 0),
    id: source.id,
    isPrimary: source.isPrimary,
    jobTitle: source.jobTitle,
    name: source.name,
    phone: source.phone,
    phoneMasked: mask(source.phone, 3, 4),
    usageScene: source.usageScene,
    version: source.version,
  };
}

export async function mockFetchCustomers(
  query: CustomerListQuery = {},
): Promise<CustomerPage> {
  const keyword = (query.keyword ?? '').trim();
  const statuses = query.status ?? [];

  let rows = store.filter((record) => {
    if (statuses.length > 0 && !statuses.includes(record.customer.status)) {
      return false;
    }
    if (
      query.ownerOperatorId &&
      record.customer.owner?.id !== query.ownerOperatorId
    ) {
      return false;
    }
    if (keyword !== '') {
      const haystack = `${record.customer.name} ${record.customer.customerNo}`;
      if (!haystack.includes(keyword)) {
        return false;
      }
    }
    return true;
  });

  const sort = query.sort ?? 'createdAt';
  const order = query.order ?? 'desc';
  rows = rows.toSorted((left, right) => {
    const a =
      sort === 'name' ? left.customer.name : String(left.customer[sort]);
    const b =
      sort === 'name' ? right.customer.name : String(right.customer[sort]);
    const compared = a.localeCompare(b, 'zh-Hans-CN');
    return order === 'asc' ? compared : -compared;
  });

  const pageSize = query.pageSize ?? 15;
  const page = query.page ?? 1;
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

export async function mockCreateCustomer(
  body: CustomerCreateInput,
): Promise<CustomerCreateResult> {
  const name = body.name.trim();
  if (name === '') {
    throw new OpsApiError({
      code: 'VALIDATION_ERROR',
      details: { issues: [{ code: 'too_small', path: ['name'] }] },
      kind: 'http',
      retryable: false,
      status: 400,
      userMessage: '客户名称不能为空',
    });
  }

  const duplicateHints = store
    .filter((record) => record.customer.name === name)
    .map((record) => ({
      customerNo: record.customer.customerNo,
      id: record.customer.id,
      name: record.customer.name,
      reason: 'name',
    }));

  customerSequence += 1;
  const customerNo = `KH-2026-${String(customerSequence).padStart(6, '0')}`;
  const now = new Date().toISOString();
  const customer: Customer = {
    archivedAt: null,
    archiveReason: null,
    createdAt: now,
    customerNo,
    id: `cus-${String(customerSequence).padStart(4, '0')}`,
    internalNote: body.internalNote ?? null,
    name,
    owner: body.ownerOperatorId
      ? { displayName: body.ownerOperatorId, id: body.ownerOperatorId }
      : null,
    regionCode: body.regionCode ?? null,
    sourceNote: body.sourceNote ?? null,
    status: 'signed',
    unifiedSocialCreditCode: body.unifiedSocialCreditCode ?? null,
    updatedAt: now,
    version: 1,
  };

  const contacts: ContactWithSecret[] = (body.contacts ?? []).map((item) => {
    contactSequence += 1;
    return {
      email: item.email ?? null,
      emailMasked: mask(item.email ?? null, 1, 0),
      id: `ct-${String(contactSequence).padStart(4, '0')}`,
      isPrimary: item.isPrimary ?? false,
      jobTitle: item.jobTitle ?? null,
      name: item.name,
      phone: item.phone ?? null,
      phoneMasked: mask(item.phone ?? null, 3, 4),
      usageScene: item.usageScene ?? null,
      version: 1,
    };
  });
  if (contacts.length > 0 && !contacts.some((item) => item.isPrimary)) {
    const first = contacts[0];
    if (first) {
      first.isPrimary = true;
    }
  }

  store.unshift({
    contacts,
    counts: {
      contracts: 0,
      deployments: 0,
      licenses: 0,
      receivables: 0,
      subscriptions: 0,
      tickets: 0,
    },
    customer,
  });

  return delay({ customer: clone(customer), duplicateHints });
}

export async function mockCheckCustomerDuplicates(body: {
  name: string;
}): Promise<CustomerDuplicateCheckResult> {
  const items = store
    .filter((record) => record.customer.name.includes(body.name.trim()))
    .map((record) => ({
      customerNo: record.customer.customerNo,
      id: record.customer.id,
      matchReason: 'name',
      name: record.customer.name,
    }));
  return delay({ items });
}

export async function mockFetchCustomer(
  customerId: string,
): Promise<CustomerDetail> {
  const record = findRecord(customerId);
  return delay({
    contacts: record.contacts.map((item) => toContact(item)),
    counts: { ...record.counts },
    customer: clone(record.customer),
  });
}

export async function mockUpdateCustomer(
  customerId: string,
  body: CustomerUpdateInput,
): Promise<{ customer: Customer }> {
  const record = findRecord(customerId);
  if (body.version !== record.customer.version) {
    throw conflict('客户档案已被他人修改，请刷新后重试');
  }
  const next: Customer = {
    ...record.customer,
    internalNote:
      body.internalNote === undefined
        ? record.customer.internalNote
        : body.internalNote,
    name: body.name?.trim() ?? record.customer.name,
    regionCode:
      body.regionCode === undefined
        ? record.customer.regionCode
        : body.regionCode,
    sourceNote:
      body.sourceNote === undefined
        ? record.customer.sourceNote
        : body.sourceNote,
    unifiedSocialCreditCode:
      body.unifiedSocialCreditCode === undefined
        ? record.customer.unifiedSocialCreditCode
        : body.unifiedSocialCreditCode,
    updatedAt: new Date().toISOString(),
    version: record.customer.version + 1,
  };
  record.customer = next;
  return delay({ customer: clone(next) });
}

const TRANSITION_TARGET: Record<
  CustomerTransitionInput['action'],
  { from: CustomerStatus[]; to: CustomerStatus }
> = {
  activate: { from: ['onboarding'], to: 'active' },
  resume: { from: ['suspended'], to: 'active' },
  start_onboarding: { from: ['signed'], to: 'onboarding' },
  suspend: { from: ['active'], to: 'suspended' },
  terminate: {
    from: ['active', 'onboarding', 'signed', 'suspended'],
    to: 'terminated',
  },
};

export async function mockTransitionCustomer(
  customerId: string,
  body: CustomerTransitionInput,
): Promise<CustomerTransitionResult> {
  const record = findRecord(customerId);
  if (body.version !== record.customer.version) {
    throw conflict('客户档案已被他人修改，请刷新后重试');
  }
  const rule = TRANSITION_TARGET[body.action];
  if (!rule || !rule.from.includes(record.customer.status)) {
    throw stateConflict(
      `当前状态（${record.customer.status}）不允许执行该操作`,
      Object.entries(TRANSITION_TARGET)
        .filter(([, value]) => value.from.includes(record.customer.status))
        .map(([action]) => action),
    );
  }
  if (body.action === 'start_onboarding' && record.contacts.length === 0) {
    throw stateConflict('客户至少需要一条联系人才可进入交付');
  }
  if (!body.reason?.trim()) {
    throw new OpsApiError({
      code: 'VALIDATION_ERROR',
      details: { issues: [{ code: 'too_small', path: ['reason'] }] },
      kind: 'http',
      retryable: false,
      status: 400,
      userMessage: '该操作必须填写原因',
    });
  }
  if (body.action === 'terminate' && record.counts.contracts > 0) {
    throw new OpsApiError({
      code: 'OBJECT_REFERENCED',
      kind: 'http',
      retryable: false,
      status: 409,
      userMessage: '该客户仍有关联合同、授权、工单或部署实例，不能终止',
    });
  }

  record.customer.status = rule.to;
  record.customer.version += 1;
  record.customer.updatedAt = new Date().toISOString();
  if (rule.to === 'terminated') {
    record.customer.archivedAt = record.customer.updatedAt;
    record.customer.archiveReason = body.reason;
  }

  return delay({
    customer: {
      status: record.customer.status,
      version: record.customer.version,
    },
    impact: {
      contracts: record.counts.contracts,
      deployments: record.counts.deployments,
      entitlements: record.counts.subscriptions + record.counts.licenses,
      tickets: record.counts.tickets,
    },
  });
}

export async function mockFetchCustomerOverview(
  customerId: string,
): Promise<CustomerOverview> {
  const record = findRecord(customerId);
  const contracts = Array.from(
    { length: record.counts.contracts },
    (_, index) => ({
      contractNo: `HT-2026-0000${index + 1}0`,
      currency: 'CNY',
      id: `con-${customerId}-${index}`,
      status: index === 0 ? 'active' : 'draft',
      totalAmount: 128_000 + index * 20_000,
    }),
  );
  return delay({
    contracts,
    deployments: Array.from(
      { length: record.counts.deployments },
      (_, index) => ({
        id: `dep-${customerId}-${index}`,
        instanceNo: `BS-2026-0000${index + 1}`,
        name: '示例生产实例',
        status: 'active',
      }),
    ),
    licenses: Array.from({ length: record.counts.licenses }, (_, index) => ({
      id: `lic-${customerId}-${index}`,
      licenseNo: `SQ-2026-0000${index + 1}`,
      status: 'active',
      validTo: '2027-09-30',
    })),
    receivables: Array.from(
      { length: record.counts.receivables },
      (_, index) => ({
        amount: 32_000,
        contractId: contracts[0]?.id ?? '',
        currency: 'CNY',
        dueDate: `2026-${String((index % 12) + 1).padStart(2, '0')}-15`,
        id: `rec-${customerId}-${index}`,
        outstanding: index % 3 === 0 ? 32_000 : 0,
        status: index % 3 === 0 ? 'upcoming' : 'paid',
      }),
    ),
    subscriptions: Array.from(
      { length: record.counts.subscriptions },
      (_, index) => ({
        endsOn: '2027-08-31',
        id: `sub-${customerId}-${index}`,
        status: 'active',
        subscriptionNo: `DY-2026-0000${index + 1}`,
      }),
    ),
    tenantMappings: [],
    tickets: Array.from({ length: record.counts.tickets }, (_, index) => ({
      id: `tkt-${customerId}-${index}`,
      status: index === 0 ? 'in_progress' : 'resolved',
      subject: '示例工单主题',
      ticketNo: `GD-2026-0000${index + 1}`,
    })),
  });
}

export async function mockFetchCustomerContacts(
  customerId: string,
): Promise<CustomerContactList> {
  const record = findRecord(customerId);
  return delay({
    items: record.contacts.map((item) => toContact(item)),
  });
}

function nextContactId(): string {
  contactSequence += 1;
  return `ct-${String(contactSequence).padStart(4, '0')}`;
}

export async function mockCreateCustomerContact(
  customerId: string,
  body: CustomerContactInput,
): Promise<{ contact: CustomerContact }> {
  const record = findRecord(customerId);
  if (!body.name?.trim()) {
    throw new OpsApiError({
      code: 'VALIDATION_ERROR',
      details: { issues: [{ code: 'too_small', path: ['name'] }] },
      kind: 'http',
      retryable: false,
      status: 400,
      userMessage: '联系人姓名不能为空',
    });
  }
  const isPrimary = body.isPrimary ?? record.contacts.length === 0;
  if (isPrimary) {
    // 契约 §5.2：主要联系人冲突时自动降级旧主要联系人，不返回 409
    record.contacts = record.contacts.map((item) => ({
      ...item,
      isPrimary: false,
    }));
  }
  const contact: ContactWithSecret = {
    email: body.email ?? null,
    emailMasked: mask(body.email ?? null, 1, 0),
    id: nextContactId(),
    isPrimary,
    jobTitle: body.jobTitle ?? null,
    name: body.name.trim(),
    phone: body.phone ?? null,
    phoneMasked: mask(body.phone ?? null, 3, 4),
    usageScene: body.usageScene ?? null,
    version: 1,
  };
  record.contacts.push(contact);
  return delay({ contact: toContact(contact) });
}

export async function mockUpdateCustomerContact(
  customerId: string,
  contactId: string,
  body: CustomerContactInput & { version: number },
): Promise<{ contact: CustomerContact }> {
  const record = findRecord(customerId);
  const target = record.contacts.find((item) => item.id === contactId);
  if (!target) {
    throw notFound();
  }
  if (body.version !== target.version) {
    throw conflict('联系人已被他人修改，请刷新后重试');
  }
  if (body.isPrimary) {
    record.contacts = record.contacts.map((item) =>
      item.id === contactId ? item : { ...item, isPrimary: false },
    );
  }
  target.name = body.name?.trim() ?? target.name;
  target.jobTitle = body.jobTitle ?? target.jobTitle;
  target.phone = body.phone ?? target.phone;
  target.email = body.email ?? target.email;
  target.usageScene = body.usageScene ?? target.usageScene;
  target.isPrimary = body.isPrimary ?? target.isPrimary;
  target.phoneMasked = mask(target.phone, 3, 4);
  target.emailMasked = mask(target.email, 1, 0);
  target.version += 1;
  return delay({ contact: toContact(target) });
}

export async function mockDeleteCustomerContact(
  customerId: string,
  contactId: string,
): Promise<{ deletedContactId: string }> {
  const record = findRecord(customerId);
  const target = record.contacts.find((item) => item.id === contactId);
  if (!target) {
    throw notFound();
  }
  if (
    target.isPrimary &&
    record.contacts.length > 1 &&
    record.customer.status !== 'terminated'
  ) {
    throw stateConflict('唯一主要联系人不能直接删除，请先指定新的主要联系人');
  }
  record.contacts = record.contacts.filter((item) => item.id !== contactId);
  return delay({ deletedContactId: contactId });
}
