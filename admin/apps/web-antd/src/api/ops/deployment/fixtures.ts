/**
 * 开发态部署桩的**虚构**数据。
 *
 * 硬约束（契约 §3.7 禁用列清单 + PRD §6.8）：
 * 1. 全部为虚构客户、虚构实例编号、虚构版本号；客户名统一带「（虚构）」后缀；
 * 2. **不出现**真实主机名、IP、域名、SSH 私钥/口令、数据库口令、安装包地址；
 *    环境标识只写可读的人工标识（`环境标识·华东A（虚构）`），不是可解析地址；
 * 3. 只在 `VITE_OPS_MOCK=true` 且非生产构建时加载（见 `endpoints.ts`）；
 * 4. 页面必须同时展示「开发态数据」提示——桩数据绝不冒充真实集成；
 * 5. 版本升级记录在桩里也是**只增不改**：任何登记都 push 一条新记录，
 *    既有记录不被改写（契约 §3.7「仅 INSERT」）。
 *
 * 维护期刻意覆盖三种分支（相对服务端业务日期 2026-10-29）：
 * - `d1` 2026-11-15 → 30 天内到期（将到期高亮）
 * - `d2` 2026-08-31 → 已到期（红色高亮）
 * - `d3` 2027-06-30 → 维护期内
 * - `d4` 未登记 → 无法判定
 */
import type {
  DeploymentInstanceStatus,
  DeploymentLicenseRef,
  DeploymentType,
  DeploymentVersionRecord,
} from './types';

/** 桩会话里的当前运营成员（与 billing/entitlement 桩保持同一 id，便于串联演示）。 */
export const STUB_CURRENT_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

/** 测试与桩内部使用的固定 id（命名常量漂移会直接编译失败，比非空断言安全）。 */
export const STUB_INSTANCE_EXPIRING_ID = '66666666-6666-4666-8666-666666666601';
export const STUB_INSTANCE_EXPIRED_ID = '66666666-6666-4666-8666-666666666602';
export const STUB_INSTANCE_HEALTHY_ID = '66666666-6666-4666-8666-666666666603';
export const STUB_INSTANCE_RETIRED_ID = '66666666-6666-4666-8666-666666666604';

export const STUB_OPERATORS = {
  /** 交付运营：负责登记上线与升级。 */
  delivery: {
    displayName: '交付运营·林（虚构）',
    id: '00000000-0000-4000-8000-000000000004',
  },
  /** 售后支持：负责维护期跟进。 */
  support: {
    displayName: '售后支持·赵（虚构）',
    id: '00000000-0000-4000-8000-000000000005',
  },
  /** 当前登录的演示运营（与 STUB_CURRENT_OPERATOR_ID 对应）。 */
  current: {
    displayName: '开发桩·演示运营（虚构）',
    id: STUB_CURRENT_OPERATOR_ID,
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
  c3: {
    customerNo: 'KH-2026-000103',
    id: '11111111-1111-4111-8111-111111111203',
    name: '示例旅行社丙（虚构）',
  },
  c4: {
    customerNo: 'KH-2026-000104',
    id: '11111111-1111-4111-8111-111111111204',
    name: '示例旅行社丁（虚构）',
  },
} as const;

export const STUB_PRODUCTS = {
  privateEdition: {
    code: 'travel-private',
    id: '33333333-3333-4333-8333-333333333301',
    name: '旅行社私有化版（虚构）',
  },
} as const;

/** 桩内实例行（内部形态：客户用 id 关联，出站时再展开为 `customer{...}`）。 */
export interface StubInstanceRow {
  contractId: null | string;
  currentVersion: null | string;
  customerId: string;
  deploymentType: DeploymentType;
  environmentRef: null | string;
  goLiveOn: null | string;
  id: string;
  instanceNo: string;
  lastVersionRecordAt: null | string;
  licenseId: null | string;
  maintenanceUntil: null | string;
  name: string;
  ownerOperatorId: null | string;
  productId: string;
  status: DeploymentInstanceStatus;
  version: number;
}

export const STUB_INSTANCES: StubInstanceRow[] = [
  {
    contractId: '22222222-2222-4222-8222-222222222301',
    currentVersion: 'v1.2.3',
    customerId: STUB_CUSTOMERS.c1.id,
    deploymentType: 'private',
    environmentRef: '环境标识·华东A（虚构）',
    goLiveOn: '2025-03-18',
    id: STUB_INSTANCE_EXPIRING_ID,
    instanceNo: 'DP-2026-000601',
    lastVersionRecordAt: '2026-09-12T03:20:00Z',
    licenseId: '99999999-9999-4999-8999-999999999901',
    maintenanceUntil: '2026-11-15',
    name: '示例旅行社甲·私有化实例A（虚构）',
    ownerOperatorId: STUB_OPERATORS.delivery.id,
    productId: STUB_PRODUCTS.privateEdition.id,
    status: 'active',
    version: 4,
  },
  {
    contractId: null,
    currentVersion: 'v1.2.0',
    customerId: STUB_CUSTOMERS.c2.id,
    deploymentType: 'dedicated',
    environmentRef: '环境标识·华南B（虚构）',
    goLiveOn: '2024-11-05',
    id: STUB_INSTANCE_EXPIRED_ID,
    instanceNo: 'DP-2026-000602',
    lastVersionRecordAt: '2026-04-02T08:05:00Z',
    licenseId: '99999999-9999-4999-8999-999999999902',
    maintenanceUntil: '2026-08-31',
    name: '示例旅行社乙·托管实例B（虚构）',
    ownerOperatorId: STUB_OPERATORS.support.id,
    productId: STUB_PRODUCTS.privateEdition.id,
    status: 'maintenance',
    version: 2,
  },
  {
    contractId: null,
    currentVersion: 'v1.1.8',
    customerId: STUB_CUSTOMERS.c3.id,
    deploymentType: 'private',
    environmentRef: '环境标识·华北C（虚构）',
    goLiveOn: null,
    id: STUB_INSTANCE_HEALTHY_ID,
    instanceNo: 'DP-2026-000603',
    lastVersionRecordAt: null,
    licenseId: null,
    maintenanceUntil: '2027-06-30',
    name: '示例旅行社丙·私有化实例C（虚构）',
    ownerOperatorId: STUB_OPERATORS.delivery.id,
    productId: STUB_PRODUCTS.privateEdition.id,
    status: 'planned',
    version: 1,
  },
  {
    contractId: null,
    currentVersion: 'v1.0.9',
    customerId: STUB_CUSTOMERS.c4.id,
    deploymentType: 'private',
    environmentRef: null,
    goLiveOn: '2024-06-01',
    id: STUB_INSTANCE_RETIRED_ID,
    instanceNo: 'DP-2026-000604',
    lastVersionRecordAt: '2025-01-10T01:00:00Z',
    licenseId: null,
    maintenanceUntil: null,
    name: '示例旅行社丁·私有化实例D（虚构，已退役）',
    ownerOperatorId: null,
    productId: STUB_PRODUCTS.privateEdition.id,
    status: 'retired',
    version: 3,
  },
];

/**
 * 桩内的升级记录（**只追加**）。
 * `instanceId` 与上面的实例一一对应，按 `executedOn` 倒序返回。
 */
export const STUB_VERSION_RECORDS: DeploymentVersionRecord[] = [
  {
    createdAt: '2026-09-12T03:20:00Z',
    executedBy: STUB_OPERATORS.delivery.id,
    executedOn: '2026-09-12',
    fromVersion: 'v1.2.2',
    id: '77777777-7777-4777-8777-777777777701',
    impactNote: '常规补丁升级，无需停机维护窗口（虚构）',
    instanceId: STUB_INSTANCE_EXPIRING_ID,
    result: 'succeeded',
    rollbackNote: null,
    toVersion: 'v1.2.3',
  },
  {
    createdAt: '2026-08-20T06:10:00Z',
    executedBy: STUB_OPERATORS.delivery.id,
    executedOn: '2026-08-20',
    fromVersion: 'v1.2.1',
    id: '77777777-7777-4777-8777-777777777702',
    impactNote: '升级后报表导出报错，已回滚至 v1.2.1（虚构）',
    instanceId: STUB_INSTANCE_EXPIRING_ID,
    result: 'rolled_back',
    rollbackNote: '回滚脚本执行完成，实例版本保持 v1.2.1',
    toVersion: 'v1.2.2',
  },
  {
    createdAt: '2026-07-02T02:00:00Z',
    executedBy: STUB_OPERATORS.support.id,
    executedOn: '2026-07-02',
    fromVersion: 'v1.2.0',
    id: '77777777-7777-4777-8777-777777777703',
    impactNote: '客户环境磁盘空间不足，升级中断（虚构）',
    instanceId: STUB_INSTANCE_EXPIRING_ID,
    result: 'failed',
    rollbackNote: null,
    toVersion: 'v1.2.1',
  },
  {
    createdAt: '2026-04-02T08:05:00Z',
    executedBy: STUB_OPERATORS.support.id,
    executedOn: '2026-04-02',
    fromVersion: 'v1.1.6',
    id: '77777777-7777-4777-8777-777777777704',
    impactNote: '维护期内例行升级（虚构）',
    instanceId: STUB_INSTANCE_EXPIRED_ID,
    result: 'succeeded',
    rollbackNote: null,
    toVersion: 'v1.2.0',
  },
];

/** 桩内授权摘要（字段与契约 §5.8 详情 `licenses[]` 对齐）。 */
export const STUB_LICENSES: Record<string, DeploymentLicenseRef> = {
  [STUB_INSTANCE_EXPIRING_ID]: {
    id: '99999999-9999-4999-8999-999999999901',
    licenseMode: 'perpetual',
    licenseNo: 'LIC-2026-000052（虚构）',
    maintenanceUntil: '2026-11-15',
    status: 'active',
    validFrom: '2025-03-01',
    validTo: null,
  },
  [STUB_INSTANCE_EXPIRED_ID]: {
    id: '99999999-9999-4999-8999-999999999902',
    licenseMode: 'term',
    licenseNo: 'LIC-2026-000058（虚构）',
    maintenanceUntil: '2026-08-31',
    status: 'expired',
    validFrom: '2024-11-01',
    validTo: '2026-08-31',
  },
};
