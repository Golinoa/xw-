/**
 * 开发态租户交付桩的**虚构**数据。
 *
 * 硬约束：
 * 1. 全部为虚构旅行社、虚构 `udone_organization_id`、虚构客户 ID，
 *    禁止写入任何真实租户或真实组织 ID；
 * 2. 名称带「（虚构）」后缀，编号使用连续演示序号；
 * 3. 只在 `VITE_OPS_MOCK=true` 时加载（见 `endpoints.ts`），页面必须同时展示
 *    「开发态数据」提示——桩数据绝不冒充真实集成；
 * 4. 桩要能演示四种交付状态：成功、transient 可重试、permanent 不可重试、
 *    版本冲突（409 `SYNC_VERSION_CONFLICT`）。
 */
import type {
  TenantAttemptOutcome,
  TenantCommandStatus,
  TenantCommandType,
  TenantCustomerRef,
  TenantErrorCategory,
  TenantMappingStatus,
} from './types';

/** 桩会话里的当前运营成员（与其它域桩保持一致）。 */
export const STUB_CURRENT_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

export const STUB_TENANT_CUSTOMERS: Record<string, TenantCustomerRef> = {
  jia: {
    customerNo: 'KH-2026-000101',
    id: '11111111-1111-4111-8111-111111111101',
    name: '示例旅行社甲（虚构）',
  },
  yi: {
    customerNo: 'KH-2026-000102',
    id: '11111111-1111-4111-8111-111111111102',
    name: '示例旅行社乙（虚构）',
  },
  bing: {
    customerNo: 'KH-2026-000103',
    id: '11111111-1111-4111-8111-111111111103',
    name: '示例旅行社丙（虚构）',
  },
  ding: {
    customerNo: 'KH-2026-000104',
    id: '11111111-1111-4111-8111-111111111104',
    name: '示例旅行社丁（虚构）',
  },
};

/** 虚构产品 ID（真实产品由 catalog 域提供，这里只用于演示筛选）。 */
export const STUB_PRODUCT_IDS = {
  saas: 'prod-tour-saas-01',
  privateDeploy: 'prod-tour-private-01',
} as const;

/**
 * 取虚构客户引用。
 *
 * 桩数据缺键属于 fixtures 写错（不是业务分支），因此直接抛错而不是回退成
 * 「未知客户」——避免桩把数据缺陷伪装成正常渲染。
 */
export function stubCustomerRef(key: string): TenantCustomerRef {
  const found = STUB_TENANT_CUSTOMERS[key];
  if (!found) {
    throw new Error(`桩数据缺少客户键：${key}`);
  }
  return { ...found };
}

/** 虚构的外部租户 ID（`udone_organization_id`），UUID 仅供演示。 */
export const STUB_UDONE_ORGS = {
  jia01: '0f0e0d0c-0b0a-4a4b-8c8d-0e0f1a2b3c01',
  jia02: '0f0e0d0c-0b0a-4a4b-8c8d-0e0f1a2b3c02',
  yi01: '0f0e0d0c-0b0a-4a4b-8c8d-0e0f1a2b3c03',
  bing01: '0f0e0d0c-0b0a-4a4b-8c8d-0e0f1a2b3c04',
  ding01: '0f0e0d0c-0b0a-4a4b-8c8d-0e0f1a2b3c05',
  /** 预留给「冲突演示」：已被示例旅行社乙占用，创建时会被拒绝。 */
  occupied: '0f0e0d0c-0b0a-4a4b-8c8d-0e0f1a2b3c99',
} as const;

export interface StubMappingRow {
  customerKey: string;
  externalRef?: null | string;
  id: string;
  lastKnownState?: null | string;
  lastSyncedAt?: null | string;
  mappingNo: string;
  mappingStatus: TenantMappingStatus;
  productId: string;
  syncVersion: number;
  udoneOrganizationId: string;
  version: number;
  /**
   * 仅桩使用：下一次下发命令前把 `syncVersion` 推进 1，模拟「另一位运营刚完成同步」，
   * 从而稳定复现 409 `SYNC_VERSION_CONFLICT`。真实环境由并发写入自然产生。
   */
  demoSyncVersionDrift?: boolean;
}

export interface StubCommandRow {
  attemptCount: number;
  commandNo: string;
  commandType: TenantCommandType;
  completedAt?: null | string;
  contractId?: null | string;
  createdAt: string;
  id: string;
  idempotencyKey: string;
  lastErrorCategory?: null | TenantErrorCategory;
  lastErrorCode?: null | string;
  mappingId: string;
  nextRetryAt?: null | string;
  reason: string;
  requestId?: null | string;
  status: TenantCommandStatus;
  version: number;
}

export interface StubAttemptRow {
  attemptNo: number;
  commandId: string;
  errorCategory?: null | TenantErrorCategory;
  finishedAt?: null | string;
  httpStatus?: null | number;
  outcome: TenantAttemptOutcome;
  requestId?: null | string;
  startedAt: string;
}

export const STUB_TENANT_MAPPINGS: StubMappingRow[] = [
  {
    customerKey: 'jia',
    externalRef: 'example-jia-prod',
    id: '44444444-4444-4444-8444-444444444401',
    lastKnownState: 'active',
    lastSyncedAt: '2026-10-27T09:12:00Z',
    mappingNo: 'TM-2026-000401',
    mappingStatus: 'active',
    productId: STUB_PRODUCT_IDS.saas,
    syncVersion: 7,
    udoneOrganizationId: STUB_UDONE_ORGS.jia01,
    version: 4,
  },
  {
    customerKey: 'yi',
    externalRef: null,
    id: '44444444-4444-4444-8444-444444444402',
    lastKnownState: 'pending',
    lastSyncedAt: null,
    mappingNo: 'TM-2026-000402',
    mappingStatus: 'pending',
    productId: STUB_PRODUCT_IDS.saas,
    syncVersion: 0,
    udoneOrganizationId: STUB_UDONE_ORGS.yi01,
    version: 1,
  },
  {
    customerKey: 'bing',
    externalRef: 'example-bing-onprem',
    id: '44444444-4444-4444-8444-444444444403',
    lastKnownState: 'active',
    lastSyncedAt: '2026-10-20T02:30:00Z',
    mappingNo: 'TM-2026-000403',
    mappingStatus: 'active',
    productId: STUB_PRODUCT_IDS.privateDeploy,
    syncVersion: 3,
    udoneOrganizationId: STUB_UDONE_ORGS.bing01,
    version: 2,
  },
  {
    customerKey: 'ding',
    demoSyncVersionDrift: true,
    externalRef: 'example-ding-prod',
    id: '44444444-4444-4444-8444-444444444404',
    lastKnownState: 'active',
    lastSyncedAt: '2026-10-28T11:00:00Z',
    mappingNo: 'TM-2026-000404',
    mappingStatus: 'active',
    productId: STUB_PRODUCT_IDS.saas,
    syncVersion: 5,
    udoneOrganizationId: STUB_UDONE_ORGS.ding01,
    version: 3,
  },
  {
    customerKey: 'jia',
    externalRef: 'example-jia-staging',
    id: '44444444-4444-4444-8444-444444444405',
    lastKnownState: 'suspended',
    lastSyncedAt: '2026-10-25T06:45:00Z',
    mappingNo: 'TM-2026-000405',
    mappingStatus: 'suspended',
    productId: STUB_PRODUCT_IDS.saas,
    syncVersion: 2,
    udoneOrganizationId: STUB_UDONE_ORGS.jia02,
    version: 2,
  },
];

export const STUB_TENANT_COMMANDS: StubCommandRow[] = [
  {
    attemptCount: 1,
    commandNo: 'TC-2026-000501',
    commandType: 'provision',
    completedAt: '2026-10-20T01:10:00Z',
    createdAt: '2026-10-20T01:09:30Z',
    id: '55555555-5555-4555-8555-555555555501',
    idempotencyKey: 'demo-cmd-provision-0001',
    mappingId: '44444444-4444-4444-8444-444444444401',
    reason: '合同 HT-2026-000201 生效，首次开通（虚构）',
    requestId: 'req-demo-0001',
    status: 'succeeded',
    version: 2,
  },
  {
    attemptCount: 2,
    commandNo: 'TC-2026-000502',
    commandType: 'sync_entitlement',
    createdAt: '2026-10-28T03:00:00Z',
    id: '55555555-5555-4555-8555-555555555502',
    idempotencyKey: 'demo-cmd-sync-0002',
    lastErrorCategory: 'transient',
    lastErrorCode: 'UPSTREAM_TIMEOUT',
    mappingId: '44444444-4444-4444-8444-444444444401',
    nextRetryAt: '2026-10-29T03:10:00Z',
    reason: '新增「电子合同」功能键后同步权益（虚构）',
    requestId: 'req-demo-0002',
    status: 'failed',
    version: 5,
  },
  {
    attemptCount: 1,
    commandNo: 'TC-2026-000503',
    commandType: 'revoke',
    completedAt: '2026-10-26T08:00:00Z',
    createdAt: '2026-10-26T07:59:00Z',
    id: '55555555-5555-4555-8555-555555555503',
    idempotencyKey: 'demo-cmd-revoke-0003',
    lastErrorCategory: 'permanent',
    lastErrorCode: 'ENTITLEMENT_NOT_FOUND',
    mappingId: '44444444-4444-4444-8444-444444444403',
    reason: '客户退订「多门店」功能键（虚构）',
    requestId: 'req-demo-0003',
    status: 'failed',
    version: 3,
  },
  {
    attemptCount: 0,
    commandNo: 'TC-2026-000504',
    commandType: 'suspend',
    createdAt: '2026-10-29T00:20:00Z',
    id: '55555555-5555-4555-8555-555555555504',
    idempotencyKey: 'demo-cmd-suspend-0004',
    mappingId: '44444444-4444-4444-8444-444444444401',
    reason: '客户逾期 30 天，按合同暂停服务（虚构）',
    status: 'pending',
    version: 1,
  },
  {
    attemptCount: 1,
    commandNo: 'TC-2026-000505',
    commandType: 'resume',
    completedAt: '2026-10-25T07:00:00Z',
    createdAt: '2026-10-25T06:58:00Z',
    id: '55555555-5555-4555-8555-555555555505',
    idempotencyKey: 'demo-cmd-resume-0005',
    mappingId: '44444444-4444-4444-8444-444444444405',
    reason: '客户完成补缴，恢复服务（虚构）',
    requestId: 'req-demo-0005',
    status: 'succeeded',
    version: 2,
  },
];

export const STUB_TENANT_ATTEMPTS: StubAttemptRow[] = [
  {
    attemptNo: 1,
    commandId: '55555555-5555-4555-8555-555555555501',
    finishedAt: '2026-10-20T01:09:55Z',
    httpStatus: 200,
    outcome: 'succeeded',
    requestId: 'req-demo-0001',
    startedAt: '2026-10-20T01:09:31Z',
  },
  {
    attemptNo: 1,
    commandId: '55555555-5555-4555-8555-555555555502',
    errorCategory: 'transient',
    finishedAt: '2026-10-28T03:00:10Z',
    httpStatus: 504,
    outcome: 'failed',
    requestId: 'req-demo-0002-a1',
    startedAt: '2026-10-28T03:00:01Z',
  },
  {
    attemptNo: 2,
    commandId: '55555555-5555-4555-8555-555555555502',
    errorCategory: 'unknown',
    finishedAt: null,
    httpStatus: null,
    outcome: 'timeout',
    requestId: 'req-demo-0002-a2',
    startedAt: '2026-10-28T03:05:00Z',
  },
  {
    attemptNo: 1,
    commandId: '55555555-5555-4555-8555-555555555503',
    errorCategory: 'permanent',
    finishedAt: '2026-10-26T08:00:03Z',
    httpStatus: 422,
    outcome: 'failed',
    requestId: 'req-demo-0003',
    startedAt: '2026-10-26T07:59:02Z',
  },
  {
    attemptNo: 1,
    commandId: '55555555-5555-4555-8555-555555555505',
    errorCategory: null,
    finishedAt: '2026-10-25T07:00:02Z',
    httpStatus: 200,
    outcome: 'succeeded',
    requestId: 'req-demo-0005',
    startedAt: '2026-10-25T06:58:40Z',
  },
];
