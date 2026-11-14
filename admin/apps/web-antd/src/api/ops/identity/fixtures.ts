/**
 * identity-audit 域的**虚构**数据（开发态契约桩专用）。
 *
 * 硬约束：
 * 1. 全部虚构：邮箱统一 `example.invalid`（RFC 2606，永不投递），姓名带「（虚构）」；
 * 2. 不出现任何真实客户、真实员工、真实金额；
 * 3. 只在 `VITE_OPS_MOCK=true` 且非生产构建时被动态加载（见各客户端文件）；
 * 4. 数据刻意覆盖界面所有分支：成员三种状态、角色系统/自定义、审计正常/未知动作、
 *    导出五种状态、总览含 `partialFailures`。
 *
 * 时间基准固定为 `2026-10-30T00:00:00Z`，所有时间由基准偏移得出——桩不读本机时钟，
 * 否则同一份夹具在不同机器上会渲染出不同文案，「昨天/今天」这类断言无法复现。
 */
import type { OpsOperatorStatus } from './session';
import type {
  OpsAuditEvent,
  OpsDictionary,
  OpsExportTask,
  OpsOverview,
  OpsRoleDetail,
  OpsSettings,
} from './types';

/** 与 `api/ops/__stub__/fixtures.ts` 的会话成员保持一致，便于串联演示。 */
export const STUB_CURRENT_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const TIME_BASE = Date.parse('2026-10-30T00:00:00Z');

/** 夹具时间：按分钟偏移，避免手写一堆时间字符串写错。 */
export function stubTime(minutesFromBase: number): string {
  return new Date(TIME_BASE + minutesFromBase * 60_000).toISOString();
}

/** 服务端「现在」：桩内部推进时间也以基准为起点，不读本机时钟。 */
export const STUB_NOW = stubTime(0);

export interface StubOperatorRow {
  displayName: string;
  email: string;
  id: string;
  lastLoginAt: null | string;
  mfaRequired: boolean;
  roleCodes: string[];
  status: OpsOperatorStatus;
  /** 乐观锁版本。列表项没有它就无法满足 `PATCH` 的 `version` 必填要求。 */
  version: number;
}

export const STUB_OPERATOR_ROWS: StubOperatorRow[] = [
  {
    displayName: '平台管理员·陈（虚构）',
    email: 'admin.chen@example.invalid',
    id: STUB_CURRENT_OPERATOR_ID,
    lastLoginAt: stubTime(-30),
    mfaRequired: true,
    roleCodes: ['platform_admin'],
    status: 'active',
    version: 7,
  },
  {
    displayName: '商务运营·李（虚构）',
    email: 'sales.li@example.invalid',
    id: '00000000-0000-4000-8000-000000000011',
    lastLoginAt: stubTime(-180),
    mfaRequired: false,
    roleCodes: ['sales_ops'],
    status: 'active',
    version: 2,
  },
  {
    displayName: '财务运营·王（虚构）',
    email: 'finance.wang@example.invalid',
    id: '00000000-0000-4000-8000-000000000012',
    lastLoginAt: stubTime(-1440),
    mfaRequired: true,
    roleCodes: ['finance_ops'],
    status: 'active',
    version: 4,
  },
  {
    displayName: '交付运营·林（虚构）',
    email: 'delivery.lin@example.invalid',
    id: '00000000-0000-4000-8000-000000000013',
    lastLoginAt: null,
    mfaRequired: false,
    roleCodes: ['delivery_ops', 'support_agent'],
    status: 'invited',
    version: 1,
  },
  {
    displayName: '售后支持·赵（虚构）',
    email: 'support.zhao@example.invalid',
    id: '00000000-0000-4000-8000-000000000014',
    lastLoginAt: stubTime(-2880),
    mfaRequired: false,
    roleCodes: ['support_agent'],
    status: 'disabled',
    version: 5,
  },
  {
    displayName: '审计只读·周（虚构）',
    email: 'viewer.zhou@example.invalid',
    id: '00000000-0000-4000-8000-000000000015',
    lastLoginAt: stubTime(-4320),
    mfaRequired: false,
    roleCodes: ['ops_viewer'],
    status: 'active',
    version: 1,
  },
];

const ALL_PERMISSIONS = [
  'audit.read',
  'catalog.read',
  'catalog.write',
  'contract.approve',
  'contract.read',
  'contract.write',
  'customer.read',
  'customer.sensitive.read',
  'customer.write',
  'deployment.read',
  'deployment.write',
  'entitlement.approve',
  'entitlement.execute',
  'entitlement.read',
  'entitlement.request',
  'export.create',
  'export.read',
  'operator.manage',
  'operator.read',
  'overview.read',
  'receipt.approve',
  'receipt.reconcile',
  'receipt.record',
  'receipt.refund',
  'receipt.reverse',
  'receivable.read',
  'receivable.write',
  'role.manage',
  'settings.manage',
  'ticket.assign',
  'ticket.close',
  'ticket.create',
  'ticket.read',
  'tenant.provision',
  'tenant.read',
  'tenant.restore',
  'tenant.retry',
  'tenant.suspend',
];

export const STUB_ROLES: OpsRoleDetail[] = [
  {
    code: 'platform_admin',
    description: '拥有全部动作码；敏感动作仍需对应动作码，不做超级用户绕过。',
    id: '00000000-0000-4000-8000-000000000101',
    isSystem: true,
    name: '平台管理员',
    permissions: ALL_PERMISSIONS,
    status: 'active',
  },
  {
    code: 'sales_ops',
    description: '客户、合同、应收查询与权益申请。',
    id: '00000000-0000-4000-8000-000000000102',
    isSystem: true,
    name: '商务运营',
    permissions: [
      'customer.read',
      'customer.write',
      'customer.sensitive.read',
      'catalog.read',
      'contract.read',
      'contract.write',
      'receivable.read',
      'entitlement.read',
      'entitlement.request',
      'tenant.read',
      'deployment.read',
      'ticket.read',
      'ticket.create',
      'ticket.update',
      'overview.read',
      'export.create',
    ],
    status: 'active',
  },
  {
    code: 'finance_ops',
    description: '收款登记、审核、核销、退款与冲正。',
    id: '00000000-0000-4000-8000-000000000103',
    isSystem: true,
    name: '财务运营',
    permissions: [
      'customer.read',
      'contract.read',
      'receivable.read',
      'receivable.write',
      'receipt.record',
      'receipt.approve',
      'receipt.reconcile',
      'receipt.refund',
      'receipt.reverse',
      'entitlement.read',
      'audit.read',
      'overview.read',
      'export.create',
    ],
    status: 'active',
  },
  {
    code: 'delivery_ops',
    description: '开通、暂停、恢复租户与部署台账维护。',
    id: '00000000-0000-4000-8000-000000000104',
    isSystem: true,
    name: '交付运营',
    permissions: [
      'customer.read',
      'customer.write',
      'catalog.read',
      'contract.read',
      'entitlement.read',
      'entitlement.request',
      'entitlement.execute',
      'tenant.read',
      'tenant.provision',
      'tenant.suspend',
      'tenant.restore',
      'tenant.retry',
      'deployment.read',
      'deployment.write',
      'ticket.read',
      'ticket.update',
      'overview.read',
    ],
    status: 'active',
  },
  {
    code: 'support_agent',
    description: '售后工单全流程；不含敏感联系信息与任何账款动作。',
    id: '00000000-0000-4000-8000-000000000105',
    isSystem: true,
    name: '售后支持',
    permissions: [
      'customer.read',
      'contract.read',
      'entitlement.read',
      'tenant.read',
      'deployment.read',
      'ticket.read',
      'ticket.create',
      'ticket.assign',
      'ticket.update',
      'ticket.close',
      'overview.read',
    ],
    status: 'active',
  },
  {
    code: 'ops_viewer',
    description: '全域只读，用于审计与巡检。',
    id: '00000000-0000-4000-8000-000000000106',
    isSystem: true,
    name: '运营只读',
    permissions: [
      'customer.read',
      'catalog.read',
      'contract.read',
      'receivable.read',
      'entitlement.read',
      'tenant.read',
      'deployment.read',
      'ticket.read',
      'overview.read',
      'audit.read',
    ],
    status: 'active',
  },
  {
    code: 'audit_temp',
    description: '临时审计角色（虚构，用于演示自定义角色可编辑）。',
    id: '00000000-0000-4000-8000-000000000107',
    isSystem: false,
    name: '临时审计（虚构）',
    permissions: ['audit.read', 'overview.read'],
    status: 'disabled',
  },
];

export const STUB_SETTINGS: OpsSettings = {
  exportRetentionDays: 7,
  overviewExpiryWindowDays: 30,
  ticketDueHours: 48,
};

export const STUB_SETTINGS_META = {
  updatedAt: stubTime(-120),
  updatedBy: {
    displayName: '平台管理员·陈（虚构）',
    id: STUB_CURRENT_OPERATOR_ID,
  },
} as const;

export const STUB_DICTIONARIES: OpsDictionary[] = [
  {
    code: 'payment_methods',
    items: [
      {
        id: 'dict-item-bank',
        isActive: true,
        label: '银行转账',
        sortOrder: 1,
        value: 'bank_transfer',
      },
      {
        id: 'dict-item-alipay',
        isActive: true,
        label: '支付宝',
        sortOrder: 2,
        value: 'alipay',
      },
      {
        id: 'dict-item-cash',
        isActive: false,
        label: '现金（已停用）',
        sortOrder: 3,
        value: 'cash',
      },
    ],
    name: '收款方式',
  },
  {
    code: 'ticket_issue_types',
    items: [
      {
        id: 'dict-item-usage',
        isActive: true,
        label: '使用咨询',
        sortOrder: 1,
        value: 'usage',
      },
      {
        id: 'dict-item-fault',
        isActive: true,
        label: '故障报修',
        sortOrder: 2,
        value: 'fault',
      },
      {
        id: 'dict-item-billing',
        isActive: true,
        label: '账单争议',
        sortOrder: 3,
        value: 'billing_dispute',
      },
    ],
    name: '工单问题类型',
  },
];

export const STUB_AUDIT_EVENTS: OpsAuditEvent[] = [
  {
    action: 'role.permissions_changed',
    actor: {
      displayName: '平台管理员·陈（虚构）',
      id: STUB_CURRENT_OPERATOR_ID,
    },
    afterSummary: {
      addedPermissions: ['audit.read'],
      roleCode: 'ops_viewer',
      roleId: '00000000-0000-4000-8000-000000000106',
    },
    beforeSummary: {
      addedPermissions: [],
      roleCode: 'ops_viewer',
      roleId: '00000000-0000-4000-8000-000000000106',
    },
    createdAt: stubTime(-20),
    entityId: '00000000-0000-4000-8000-000000000106',
    entityType: 'role',
    id: 'audit-0001',
    reason: '审计巡检需要查看操作日志',
    requestId: 'req-stub-0001',
  },
  {
    action: 'operator.status_changed',
    actor: {
      displayName: '平台管理员·陈（虚构）',
      id: STUB_CURRENT_OPERATOR_ID,
    },
    afterSummary: { disabledReason: '岗位调整', status: 'disabled' },
    beforeSummary: { status: 'active' },
    createdAt: stubTime(-95),
    entityId: '00000000-0000-4000-8000-000000000014',
    entityType: 'operator',
    id: 'audit-0002',
    reason: '该同事已转岗，停止运营后台访问',
    requestId: 'req-stub-0002',
  },
  {
    action: 'export.create',
    actor: {
      displayName: '财务运营·王（虚构）',
      id: '00000000-0000-4000-8000-000000000012',
    },
    afterSummary: {
      exportNo: 'EX-2026-000007',
      exportType: 'receivables',
      rowCount: 12_345,
    },
    beforeSummary: null,
    createdAt: stubTime(-200),
    entityId: '00000000-0000-4000-8000-000000000207',
    entityType: 'export',
    id: 'audit-0003',
    reason: '月度对账需要',
    requestId: 'req-stub-0003',
  },
  {
    action: 'settings.update',
    actor: {
      displayName: '平台管理员·陈（虚构）',
      id: STUB_CURRENT_OPERATOR_ID,
    },
    afterSummary: { 'overview.expiryWindowDays': 30 },
    beforeSummary: { 'overview.expiryWindowDays': 14 },
    createdAt: stubTime(-300),
    entityId: '',
    entityType: 'settings',
    id: 'audit-0004',
    reason: '临期窗口调整为 30 天，与客户续约提醒节奏一致',
    requestId: 'req-stub-0004',
  },
  {
    action: 'operator.invite',
    actor: {
      displayName: '平台管理员·陈（虚构）',
      id: STUB_CURRENT_OPERATOR_ID,
    },
    afterSummary: {
      email: 'delivery.lin@example.invalid',
      roleCodes: ['delivery_ops', 'support_agent'],
    },
    beforeSummary: null,
    createdAt: stubTime(-1440),
    entityId: '00000000-0000-4000-8000-000000000013',
    entityType: 'operator',
    id: 'audit-0005',
    reason: '新同事入职，需要交付与售后权限',
    requestId: 'req-stub-0005',
  },
  {
    // 刻意保留一个「未登记动作」：验证界面不把它渲染成空白。
    action: 'tenant.command.replayed',
    actor: {
      displayName: '交付运营·林（虚构）',
      id: '00000000-0000-4000-8000-000000000013',
    },
    afterSummary: { attemptCount: 2, commandType: 'provision' },
    beforeSummary: { attemptCount: 1 },
    createdAt: stubTime(-2100),
    entityId: '00000000-0000-4000-8000-000000000311',
    entityType: 'tenant_command',
    id: 'audit-0006',
    reason: null,
    requestId: 'req-stub-0006',
  },
];

export const STUB_EXPORT_TASKS: OpsExportTask[] = [
  {
    completedAt: stubTime(-60),
    createdAt: stubTime(-75),
    expiresAt: stubTime(-60 + 7 * 1440),
    exportNo: 'EX-2026-000012',
    exportType: 'customers',
    id: '00000000-0000-4000-8000-000000000212',
    requestedBy: {
      displayName: '商务运营·李（虚构）',
      id: '00000000-0000-4000-8000-000000000011',
    },
    rowCount: 328,
    status: 'succeeded',
  },
  {
    completedAt: null,
    createdAt: stubTime(-10),
    expiresAt: null,
    exportNo: 'EX-2026-000013',
    exportType: 'receivables',
    id: '00000000-0000-4000-8000-000000000213',
    requestedBy: {
      displayName: '财务运营·王（虚构）',
      id: '00000000-0000-4000-8000-000000000012',
    },
    rowCount: null,
    status: 'running',
  },
  {
    completedAt: null,
    createdAt: stubTime(-2),
    expiresAt: null,
    exportNo: 'EX-2026-000014',
    exportType: 'tickets',
    id: '00000000-0000-4000-8000-000000000214',
    requestedBy: {
      displayName: '平台管理员·陈（虚构）',
      id: STUB_CURRENT_OPERATOR_ID,
    },
    rowCount: null,
    status: 'queued',
  },
  {
    completedAt: stubTime(-2880),
    createdAt: stubTime(-2900),
    expiresAt: null,
    exportNo: 'EX-2026-000011',
    exportType: 'receipts',
    id: '00000000-0000-4000-8000-000000000211',
    requestedBy: {
      displayName: '财务运营·王（虚构）',
      id: '00000000-0000-4000-8000-000000000012',
    },
    rowCount: null,
    status: 'failed',
  },
  {
    completedAt: stubTime(-20_160),
    createdAt: stubTime(-20_180),
    expiresAt: stubTime(-20_160 + 7 * 1440),
    exportNo: 'EX-2026-000009',
    exportType: 'contracts',
    id: '00000000-0000-4000-8000-000000000209',
    requestedBy: {
      displayName: '商务运营·李（虚构）',
      id: '00000000-0000-4000-8000-000000000011',
    },
    rowCount: 96,
    status: 'expired',
  },
];

export const STUB_OVERVIEW: OpsOverview = {
  amounts: [
    {
      currency: 'CNY',
      overdueReceivable: 128_000.5,
      settledReceivable: 2_460_000,
      totalReceivable: 3_180_000,
      upcomingReceivable: 592_000,
    },
    {
      // 第二种币种：验证界面按币种分组、不合并成一个总数。
      currency: 'USD',
      overdueReceivable: 0,
      settledReceivable: 12_000,
      totalReceivable: 30_000,
      upcomingReceivable: 18_000,
    },
  ],
  metrics: {
    activeContracts: 86,
    activeCustomers: 124,
    activeEntitlements: 97,
    expiringEntitlements: 9,
    failedSyncCommands: 2,
    openTickets: 17,
    pendingReceiptAmount: 96_500,
    runningTenants: 74,
    unreconciledAmount: 41_200.75,
    waitingTickets: 6,
  },
  partialFailures: [
    {
      code: 'PARTIAL_TIMEOUT',
      message: '租户同步命令指标超时，已返回其余指标（虚构）',
      section: 'failedSyncCommands',
    },
  ],
  statisticsAt: STUB_NOW,
  windowDays: 30,
};
