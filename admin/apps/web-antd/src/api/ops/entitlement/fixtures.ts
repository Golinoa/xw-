/**
 * 开发态权益桩的**虚构**数据。
 *
 * 硬约束：
 * 1. 全部为虚构客户、虚构订阅号/授权号、虚构功能键，禁止写入任何真实客户或真实合同；
 * 2. 客户名带「（虚构）」后缀，编号使用连续演示序号；
 * 3. 只在 `VITE_OPS_MOCK=true` 且非生产构建时加载（见 `endpoints.ts`）；
 * 4. 页面必须同时展示「开发态数据」提示——桩数据绝不冒充真实后端集成。
 *
 * 快照在桩里也是**只增不改**：`STUB_SNAPSHOTS` 只被追加，任何变更申请执行都
 * 生成新快照并推进 `current_snapshot_id`，历史对象本身不被改写（源码参考门 §3.4）。
 */
import type {
  BillingCycle,
  ChangeRequestStatus,
  ChangeRequestType,
  EntitlementSnapshotLine,
  EntitlementStatus,
  EntitlementSummary,
  LicenseMode,
  SnapshotSourceType,
  SnapshotTargetScope,
} from './types';

/** 桩会话里的当前运营成员（与 billing/identity 桩保持同一 id，便于串联演示）。 */
export const STUB_CURRENT_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

/**
 * 测试与桩内部常用的固定 id。
 * 用具名常量而不是 `STUB_..._[0]!.id`：非空断言会掩盖夹具漂移，命名常量漂移会直接编译失败。
 */
export const STUB_ACTIVE_SUBSCRIPTION_ID =
  '88888888-8888-4888-8888-888888888801';
export const STUB_PENDING_CHANGE_REQUEST_ID =
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
export const STUB_PERMANENT_LICENSE_ID = '99999999-9999-4999-8999-999999999902';

export const STUB_OPERATORS = {
  /** 商务运营：负责提交变更申请（不能自批）。 */
  requester: {
    displayName: '商务运营·周（虚构）',
    id: '00000000-0000-4000-8000-000000000002',
  },
  /** 交付审批：具备 entitlement.approve。 */
  approver: {
    displayName: '交付审批·陈（虚构）',
    id: '00000000-0000-4000-8000-000000000003',
  },
  /** 交付执行：具备 entitlement.execute + tenant.retry。 */
  executor: {
    displayName: '交付执行·林（虚构）',
    id: '00000000-0000-4000-8000-000000000004',
  },
} as const;

export const STUB_CUSTOMERS = {
  c1: {
    customerNo: 'KH-2026-000101',
    id: '11111111-1111-4111-8111-111111111201',
    name: '示例旅行社甲（虚构）',
  },
  c2: {
    customerNo: 'KH-2026-000102',
    id: '11111111-1111-4111-8111-111111111202',
    name: '示例旅行社乙（虚构）',
  },
} as const;

export const STUB_PRODUCTS = {
  privateEdition: {
    code: 'travel-private',
    id: '33333333-3333-4333-8333-333333333301',
    name: '旅行社私有化版（虚构）',
  },
  saas: {
    code: 'travel-saas',
    id: '33333333-3333-4333-8333-333333333302',
    name: '旅行社 SaaS 标准版（虚构）',
  },
} as const;

/** 合同状态只用于演示「来源合同未生效 → 409」的分支。 */
export const STUB_CONTRACTS = {
  active: {
    contractNo: 'HT-2026-000301',
    id: '22222222-2222-4222-8222-222222222301',
    status: 'active',
  },
  draft: {
    contractNo: 'HT-2026-000302',
    id: '22222222-2222-4222-8222-222222222302',
    status: 'draft',
  },
} as const;

export const STUB_CONTRACT_ITEMS = {
  /** 甲社 SaaS 订阅条目。 */
  itemSaas: '44444444-4444-4444-8444-444444444401',
  /** 甲社私有化条目。 */
  itemPrivate: '44444444-4444-4444-8444-444444444402',
  /** 乙社私有化条目。 */
  itemPrivateB: '44444444-4444-4444-8444-444444444403',
  /** 草稿合同下的条目：用于演示「来源合同未生效 → 409」。 */
  itemDraft: '44444444-4444-4444-8444-444444444404',
} as const;

export const STUB_DEPLOYMENTS = {
  d1: {
    id: '55555555-5555-4555-8555-555555555501',
    instanceNo: 'BJ-2026-000501',
    name: '甲社私有实例（虚构）',
    status: 'active',
  },
  d2: {
    id: '55555555-5555-4555-8555-555555555502',
    instanceNo: 'SH-2026-000502',
    name: '乙社私有实例（虚构）',
    status: 'maintenance',
  },
} as const;

/** 快照行：功能键全部为虚构键名。 */
export interface StubSnapshotRow {
  contentHash: string;
  createdAt: string;
  createdBy: string;
  customerId: string;
  id: string;
  lines: EntitlementSnapshotLine[];
  sourceId: string;
  sourceType: SnapshotSourceType;
  targetRef: null | string;
  targetScope: SnapshotTargetScope;
  validFrom: null | string;
  validTo: null | string;
}

function line(
  featureKey: string,
  displayNameSnapshot: string,
  enabled: boolean,
  quota: null | number,
  termMonths: null | number,
): EntitlementSnapshotLine {
  return { displayNameSnapshot, enabled, featureKey, quota, termMonths };
}

/**
 * 快照库（桩内「仅 INSERT」）。
 *
 * 序号：`s1`…`s5`。`s1`/`s2` 是甲社 SaaS 的历史，`s3` 是甲社私有授权，
 * `s4` 是乙社永久授权，`s5` 是乙社限期授权（已暂停）。
 */
export const STUB_SNAPSHOTS: StubSnapshotRow[] = [
  {
    contentHash: 'sha256-demo-s1',
    createdAt: '2025-12-28T02:00:00Z',
    createdBy: STUB_OPERATORS.approver.id,
    customerId: STUB_CUSTOMERS.c1.id,
    id: '66666666-6666-4666-8666-666666666601',
    lines: [
      line('travel.booking', '团队订单管理', true, null, null),
      line('travel.departure', '班期与发团', true, null, null),
      line('travel.guide', '导游排班', true, null, 12),
      line('travel.report', '经营报表', false, null, null),
    ],
    sourceId: STUB_CONTRACT_ITEMS.itemSaas,
    sourceType: 'contract_item',
    targetRef: null,
    targetScope: 'saas_tenant',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
  },
  {
    contentHash: 'sha256-demo-s2',
    createdAt: '2026-03-05T06:20:00Z',
    createdBy: STUB_OPERATORS.executor.id,
    customerId: STUB_CUSTOMERS.c1.id,
    id: '66666666-6666-4666-8666-666666666602',
    lines: [
      line('travel.booking', '团队订单管理', true, null, null),
      line('travel.departure', '班期与发团', true, null, null),
      line('travel.guide', '导游排班', true, 30, 12),
      line('travel.report', '经营报表', true, null, null),
    ],
    sourceId: '77777777-7777-4777-8777-777777777701',
    sourceType: 'change_request',
    targetRef: null,
    targetScope: 'saas_tenant',
    validFrom: '2026-03-05',
    validTo: '2026-12-31',
  },
  {
    contentHash: 'sha256-demo-s3',
    createdAt: '2026-01-04T03:10:00Z',
    createdBy: STUB_OPERATORS.approver.id,
    customerId: STUB_CUSTOMERS.c1.id,
    id: '66666666-6666-4666-8666-666666666603',
    lines: [
      line('private.core', '私有化核心模块', true, null, null),
      line('private.api', '开放接口', true, 200_000, 12),
      line('private.sso', '单点登录', false, null, null),
    ],
    sourceId: STUB_CONTRACT_ITEMS.itemPrivate,
    sourceType: 'contract_item',
    targetRef: STUB_DEPLOYMENTS.d1.id,
    targetScope: 'private_instance',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
  },
  {
    contentHash: 'sha256-demo-s4',
    createdAt: '2025-05-20T01:30:00Z',
    createdBy: STUB_OPERATORS.approver.id,
    customerId: STUB_CUSTOMERS.c2.id,
    id: '66666666-6666-4666-8666-666666666604',
    lines: [
      line('private.core', '私有化核心模块', true, null, null),
      line('private.api', '开放接口', true, 500_000, null),
    ],
    sourceId: STUB_CONTRACT_ITEMS.itemPrivateB,
    sourceType: 'contract_item',
    targetRef: STUB_DEPLOYMENTS.d2.id,
    targetScope: 'private_instance',
    validFrom: '2025-06-01',
    validTo: null,
  },
  {
    contentHash: 'sha256-demo-s5',
    createdAt: '2026-02-10T08:00:00Z',
    createdBy: STUB_OPERATORS.approver.id,
    customerId: STUB_CUSTOMERS.c2.id,
    id: '66666666-6666-4666-8666-666666666605',
    lines: [
      line('private.core', '私有化核心模块', true, null, null),
      line('private.sso', '单点登录', true, null, 6),
    ],
    sourceId: STUB_CONTRACT_ITEMS.itemPrivateB,
    sourceType: 'contract_item',
    targetRef: STUB_DEPLOYMENTS.d2.id,
    targetScope: 'private_instance',
    validFrom: '2026-03-01',
    validTo: '2027-02-28',
  },
  {
    contentHash: 'sha256-demo-s6',
    createdAt: '2026-08-28T02:00:00Z',
    createdBy: STUB_OPERATORS.approver.id,
    customerId: STUB_CUSTOMERS.c2.id,
    id: '66666666-6666-4666-8666-666666666606',
    lines: [
      line('travel.booking', '团队订单管理', true, null, null),
      line('travel.departure', '班期与发团', true, null, null),
      line('travel.report', '经营报表', false, null, null),
    ],
    sourceId: STUB_CONTRACT_ITEMS.itemSaas,
    sourceType: 'contract_item',
    targetRef: null,
    targetScope: 'saas_tenant',
    validFrom: '2026-09-01',
    validTo: '2026-11-30',
  },
];

/** 取夹具第 n 条的 id；缺失时立刻报错，避免把未定义的快照 id 写进订阅。 */
function idAt<T extends { id: string }>(
  rows: readonly T[],
  index: number,
): string {
  const row = rows[index];
  if (!row) {
    throw new Error(`stub fixture 缺少第 ${index} 条记录`);
  }
  return row.id;
}

/** 订阅行（不含内嵌客户/产品，转换在 dev-stub 里完成）。 */
export interface StubSubscriptionRow {
  autoRenewIntent: boolean;
  billingCycle: BillingCycle;
  contractId: string;
  contractItemId: string;
  currentSnapshotId: string;
  customerId: string;
  endsOn: null | string;
  id: string;
  productId: string;
  startsOn: string;
  status: EntitlementStatus;
  subscriptionNo: string;
  version: number;
}

export const STUB_SUBSCRIPTIONS: StubSubscriptionRow[] = [
  {
    autoRenewIntent: true,
    billingCycle: 'yearly',
    contractId: STUB_CONTRACTS.active.id,
    contractItemId: STUB_CONTRACT_ITEMS.itemSaas,
    currentSnapshotId: idAt(STUB_SNAPSHOTS, 1),
    customerId: STUB_CUSTOMERS.c1.id,
    endsOn: '2026-12-31',
    id: STUB_ACTIVE_SUBSCRIPTION_ID,
    productId: STUB_PRODUCTS.saas.id,
    startsOn: '2026-01-01',
    status: 'active',
    subscriptionNo: 'SUB-2026-000801',
    version: 3,
  },
  {
    autoRenewIntent: false,
    billingCycle: 'quarterly',
    contractId: STUB_CONTRACTS.active.id,
    contractItemId: STUB_CONTRACT_ITEMS.itemSaas,
    currentSnapshotId: idAt(STUB_SNAPSHOTS, 5),
    customerId: STUB_CUSTOMERS.c2.id,
    endsOn: '2026-11-30',
    id: '88888888-8888-4888-8888-888888888802',
    productId: STUB_PRODUCTS.saas.id,
    startsOn: '2026-09-01',
    status: 'pending_approval',
    subscriptionNo: 'SUB-2026-000802',
    version: 2,
  },
  {
    autoRenewIntent: false,
    billingCycle: 'monthly',
    contractId: STUB_CONTRACTS.active.id,
    contractItemId: STUB_CONTRACT_ITEMS.itemSaas,
    currentSnapshotId: idAt(STUB_SNAPSHOTS, 0),
    customerId: STUB_CUSTOMERS.c1.id,
    endsOn: '2026-10-31',
    id: '88888888-8888-4888-8888-888888888803',
    productId: STUB_PRODUCTS.saas.id,
    startsOn: '2026-04-01',
    status: 'suspended',
    subscriptionNo: 'SUB-2026-000803',
    version: 5,
  },
  {
    autoRenewIntent: false,
    billingCycle: 'yearly',
    contractId: STUB_CONTRACTS.active.id,
    contractItemId: STUB_CONTRACT_ITEMS.itemSaas,
    currentSnapshotId: idAt(STUB_SNAPSHOTS, 5),
    customerId: STUB_CUSTOMERS.c2.id,
    endsOn: '2026-06-30',
    id: '88888888-8888-4888-8888-888888888804',
    productId: STUB_PRODUCTS.saas.id,
    startsOn: '2025-07-01',
    status: 'draft',
    subscriptionNo: 'SUB-2026-000804',
    version: 1,
  },
  {
    autoRenewIntent: false,
    billingCycle: 'yearly',
    contractId: STUB_CONTRACTS.active.id,
    contractItemId: STUB_CONTRACT_ITEMS.itemSaas,
    currentSnapshotId: idAt(STUB_SNAPSHOTS, 0),
    customerId: STUB_CUSTOMERS.c1.id,
    endsOn: '2026-03-31',
    id: '88888888-8888-4888-8888-888888888805',
    productId: STUB_PRODUCTS.saas.id,
    startsOn: '2025-04-01',
    status: 'expired',
    subscriptionNo: 'SUB-2026-000805',
    version: 4,
  },
];

/** 授权行。永久授权 `validTo` 必须为 `null`（契约 §3.5 CHECK）。 */
export interface StubLicenseRow {
  contractId: string;
  contractItemId: string;
  currentSnapshotId: string;
  customerId: string;
  deploymentInstanceId: string;
  id: string;
  licenseMode: LicenseMode;
  licenseNo: string;
  maintenanceUntil: null | string;
  status: EntitlementStatus;
  validFrom: string;
  validTo: null | string;
  version: number;
}

export const STUB_LICENSES: StubLicenseRow[] = [
  {
    contractId: STUB_CONTRACTS.active.id,
    contractItemId: STUB_CONTRACT_ITEMS.itemPrivate,
    currentSnapshotId: idAt(STUB_SNAPSHOTS, 2),
    customerId: STUB_CUSTOMERS.c1.id,
    deploymentInstanceId: STUB_DEPLOYMENTS.d1.id,
    id: '99999999-9999-4999-8999-999999999901',
    licenseMode: 'term',
    licenseNo: 'LIC-2026-000901',
    maintenanceUntil: '2026-12-31',
    status: 'active',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    version: 2,
  },
  {
    contractId: STUB_CONTRACTS.active.id,
    contractItemId: STUB_CONTRACT_ITEMS.itemPrivateB,
    currentSnapshotId: idAt(STUB_SNAPSHOTS, 3),
    customerId: STUB_CUSTOMERS.c2.id,
    deploymentInstanceId: STUB_DEPLOYMENTS.d2.id,
    id: STUB_PERMANENT_LICENSE_ID,
    licenseMode: 'perpetual',
    licenseNo: 'LIC-2026-000902',
    maintenanceUntil: '2027-05-31',
    status: 'active',
    validFrom: '2025-06-01',
    validTo: null,
    version: 1,
  },
  {
    contractId: STUB_CONTRACTS.active.id,
    contractItemId: STUB_CONTRACT_ITEMS.itemPrivateB,
    currentSnapshotId: idAt(STUB_SNAPSHOTS, 4),
    customerId: STUB_CUSTOMERS.c2.id,
    deploymentInstanceId: STUB_DEPLOYMENTS.d2.id,
    id: '99999999-9999-4999-8999-999999999903',
    licenseMode: 'term',
    licenseNo: 'LIC-2026-000903',
    maintenanceUntil: '2026-09-30',
    status: 'suspended',
    validFrom: '2026-03-01',
    validTo: '2027-02-28',
    version: 3,
  },
];

/** 变更申请行（含 `before/after` 摘要，模拟 jsonb 落库形态）。 */
export interface StubChangeRequestRow {
  afterSummary: EntitlementSummary;
  approvedAt: null | string;
  approvedBy: null | string;
  beforeSummary: EntitlementSummary;
  changeType: ChangeRequestType;
  commandId: null | string;
  createdAt: string;
  executedAt: null | string;
  id: string;
  proposedSnapshotId: null | string;
  reason: string;
  requestedBy: string;
  sourceContractId: null | string;
  status: ChangeRequestStatus;
  subjectId: string;
  subjectType: 'license' | 'subscription';
  version: number;
}

function summary(features: EntitlementSummary['features']): EntitlementSummary {
  return { features };
}

export const STUB_CHANGE_REQUESTS: StubChangeRequestRow[] = [
  {
    afterSummary: summary([
      {
        displayName: '导游排班',
        enabled: true,
        featureKey: 'travel.guide',
        quota: 60,
        termMonths: 12,
      },
      {
        displayName: '经营报表',
        enabled: true,
        featureKey: 'travel.report',
        quota: null,
        termMonths: null,
      },
    ]),
    approvedAt: null,
    approvedBy: null,
    beforeSummary: summary([
      {
        displayName: '导游排班',
        enabled: true,
        featureKey: 'travel.guide',
        quota: 30,
        termMonths: 12,
      },
      {
        displayName: '经营报表',
        enabled: true,
        featureKey: 'travel.report',
        quota: null,
        termMonths: null,
      },
    ]),
    changeType: 'quota_change',
    commandId: null,
    createdAt: '2026-10-26T03:15:00Z',
    executedAt: null,
    id: STUB_PENDING_CHANGE_REQUEST_ID,
    proposedSnapshotId: null,
    reason: '客户新增两个门店，导游排班账号额度需从 30 调整为 60',
    requestedBy: STUB_OPERATORS.requester.id,
    sourceContractId: STUB_CONTRACTS.active.id,
    status: 'pending_approval',
    subjectId: idAt(STUB_SUBSCRIPTIONS, 0),
    subjectType: 'subscription',
    version: 2,
  },
  {
    afterSummary: summary([
      {
        displayName: '开放接口',
        enabled: true,
        featureKey: 'private.api',
        quota: 200_000,
        termMonths: 12,
      },
      {
        displayName: '单点登录',
        enabled: true,
        featureKey: 'private.sso',
        quota: null,
        termMonths: 12,
      },
    ]),
    approvedAt: '2026-10-24T09:00:00Z',
    approvedBy: STUB_OPERATORS.approver.id,
    beforeSummary: summary([
      {
        displayName: '开放接口',
        enabled: true,
        featureKey: 'private.api',
        quota: 200_000,
        termMonths: 12,
      },
      {
        displayName: '单点登录',
        enabled: false,
        featureKey: 'private.sso',
        quota: null,
        termMonths: null,
      },
    ]),
    changeType: 'upgrade',
    commandId: null,
    createdAt: '2026-10-23T02:40:00Z',
    executedAt: null,
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02',
    proposedSnapshotId: null,
    reason: '客户采购单点登录模块，需要启用 private.sso',
    requestedBy: STUB_OPERATORS.requester.id,
    sourceContractId: STUB_CONTRACTS.active.id,
    status: 'approved',
    subjectId: idAt(STUB_LICENSES, 0),
    subjectType: 'license',
    version: 3,
  },
  {
    afterSummary: summary([
      {
        displayName: '导游排班',
        enabled: true,
        featureKey: 'travel.guide',
        quota: 30,
        termMonths: 24,
      },
    ]),
    approvedAt: '2026-10-20T07:00:00Z',
    approvedBy: STUB_OPERATORS.approver.id,
    beforeSummary: summary([
      {
        displayName: '导游排班',
        enabled: true,
        featureKey: 'travel.guide',
        quota: 30,
        termMonths: 12,
      },
    ]),
    changeType: 'extend',
    commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01',
    createdAt: '2026-10-19T05:10:00Z',
    executedAt: null,
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03',
    proposedSnapshotId: null,
    reason: '客户要求延长导游排班期限 12 个月',
    requestedBy: STUB_OPERATORS.requester.id,
    sourceContractId: STUB_CONTRACTS.active.id,
    status: 'failed',
    subjectId: idAt(STUB_SUBSCRIPTIONS, 0),
    subjectType: 'subscription',
    version: 4,
  },
  {
    afterSummary: summary([
      {
        displayName: '团队订单管理',
        enabled: true,
        featureKey: 'travel.booking',
        quota: null,
        termMonths: null,
      },
    ]),
    approvedAt: '2026-09-30T01:00:00Z',
    approvedBy: STUB_OPERATORS.approver.id,
    beforeSummary: summary([
      {
        displayName: '团队订单管理',
        enabled: true,
        featureKey: 'travel.booking',
        quota: null,
        termMonths: null,
      },
      {
        displayName: '班期与发团',
        enabled: true,
        featureKey: 'travel.departure',
        quota: null,
        termMonths: null,
      },
    ]),
    changeType: 'suspend',
    commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02',
    createdAt: '2026-09-29T06:00:00Z',
    executedAt: '2026-09-30T02:10:00Z',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04',
    proposedSnapshotId: null,
    reason: '客户欠费暂停服务，待续费后恢复',
    requestedBy: STUB_OPERATORS.approver.id,
    sourceContractId: STUB_CONTRACTS.active.id,
    status: 'executed',
    subjectId: idAt(STUB_SUBSCRIPTIONS, 2),
    subjectType: 'subscription',
    version: 3,
  },
];
