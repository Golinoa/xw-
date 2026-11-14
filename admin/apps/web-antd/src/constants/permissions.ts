/**
 * 运营后台权限动作目录（前端消费侧唯一真源）
 *
 * 真源：`Docs/ops-api-contract.md` §4 权限动作目录。
 * 后端真源：`ops.permissions` 表 + `udone/packages/contracts/src/ops/permissions.ts`。
 * 三处必须一致，由后端 pgTAP 与前端单测双重对账。
 *
 * 规则：
 * 1. 后端只判断动作码，不判断角色名 [PRD §4.2]。前端同理——角色只用于配置权限集合，
 *    不允许出现 `if (role === 'admin')` 这类分支。
 * 2. 新增动作码必须先改 `Docs/ops-api-contract.md` 与后端契约，再改本文件；
 *    本文件不得单方面扩展，否则前端会出现后端不认的权限。
 * 3. 菜单隐藏只改善体验，不构成授权。任何受保护操作都必须由服务端再次拒绝未授权请求。
 */

/** 权限动作码。命名规则：`<领域>.<动作>`，全小写，动作为动词。 */
export const OPS_PERMISSION = {
  // ---- identity-audit：运营总览、账号、审计、导出 ----
  OVERVIEW_READ: 'overview.read',
  OPERATOR_READ: 'operator.read',
  OPERATOR_MANAGE: 'operator.manage',
  ROLE_MANAGE: 'role.manage',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_READ: 'audit.read',
  EXPORT_READ: 'export.read',
  EXPORT_CREATE: 'export.create',

  // ---- customer：软件客户与联系人 ----
  CUSTOMER_READ: 'customer.read',
  CUSTOMER_WRITE: 'customer.write',
  CUSTOMER_SENSITIVE_READ: 'customer.sensitive.read',

  // ---- catalog：产品、套餐、价格版本、功能键 ----
  CATALOG_READ: 'catalog.read',
  CATALOG_WRITE: 'catalog.write',

  // ---- contract：合同与条目 ----
  CONTRACT_READ: 'contract.read',
  CONTRACT_WRITE: 'contract.write',
  CONTRACT_APPROVE: 'contract.approve',

  // ---- billing：应收、收款、核销、退款 ----
  RECEIVABLE_READ: 'receivable.read',
  RECEIVABLE_WRITE: 'receivable.write',
  RECEIPT_RECORD: 'receipt.record',
  RECEIPT_APPROVE: 'receipt.approve',
  RECEIPT_RECONCILE: 'receipt.reconcile',
  RECEIPT_REVERSE: 'receipt.reverse',
  RECEIPT_REFUND: 'receipt.refund',

  // ---- entitlement：订阅、授权、权益快照 ----
  ENTITLEMENT_READ: 'entitlement.read',
  ENTITLEMENT_REQUEST: 'entitlement.request',
  ENTITLEMENT_APPROVE: 'entitlement.approve',
  ENTITLEMENT_EXECUTE: 'entitlement.execute',

  // ---- tenant-integration：udone 租户映射与交付命令 ----
  TENANT_READ: 'tenant.read',
  TENANT_PROVISION: 'tenant.provision',
  TENANT_SUSPEND: 'tenant.suspend',
  TENANT_RESTORE: 'tenant.restore',
  TENANT_RETRY: 'tenant.retry',

  // ---- deployment：私有化部署台账 ----
  DEPLOYMENT_READ: 'deployment.read',
  DEPLOYMENT_WRITE: 'deployment.write',

  // ---- support：售后工单 ----
  TICKET_READ: 'ticket.read',
  TICKET_CREATE: 'ticket.create',
  TICKET_ASSIGN: 'ticket.assign',
  TICKET_UPDATE: 'ticket.update',
  TICKET_CLOSE: 'ticket.close',
} as const;

export type OpsPermission =
  (typeof OPS_PERMISSION)[keyof typeof OPS_PERMISSION];

/** 全部动作码，用于登录后校验服务端返回的权限集合是否含未知值。 */
export const OPS_PERMISSION_CODES: readonly OpsPermission[] =
  Object.values(OPS_PERMISSION);

/**
 * 高风险动作 [PRD §1.3] [PRD §4.3]。
 * 前端必须：二次确认、要求填写原因、展示影响摘要；后端必须写审计并校验 `reason`。
 * 后端 `ops.permissions.is_high_risk` 为同一清单的第二真源。
 */
export const OPS_HIGH_RISK_PERMISSIONS: ReadonlySet<OpsPermission> = new Set([
  OPS_PERMISSION.CONTRACT_APPROVE,
  OPS_PERMISSION.ENTITLEMENT_APPROVE,
  OPS_PERMISSION.ENTITLEMENT_EXECUTE,
  OPS_PERMISSION.EXPORT_CREATE,
  OPS_PERMISSION.OPERATOR_MANAGE,
  OPS_PERMISSION.RECEIPT_APPROVE,
  OPS_PERMISSION.RECEIPT_RECONCILE,
  OPS_PERMISSION.RECEIPT_REFUND,
  OPS_PERMISSION.RECEIPT_REVERSE,
  OPS_PERMISSION.ROLE_MANAGE,
  OPS_PERMISSION.TENANT_PROVISION,
  OPS_PERMISSION.TENANT_RESTORE,
  OPS_PERMISSION.TENANT_RETRY,
  OPS_PERMISSION.TENANT_SUSPEND,
]);

/** 权限动作归属域，与后端领域划分、前端路由模块一一对应。 */
export const OPS_PERMISSION_DOMAIN = {
  IDENTITY_AUDIT: 'identity-audit',
  CUSTOMER: 'customer',
  CATALOG: 'catalog',
  CONTRACT: 'contract',
  BILLING: 'billing',
  ENTITLEMENT: 'entitlement',
  TENANT_INTEGRATION: 'tenant-integration',
  DEPLOYMENT: 'deployment',
  SUPPORT: 'support',
} as const;

export type OpsPermissionDomain =
  (typeof OPS_PERMISSION_DOMAIN)[keyof typeof OPS_PERMISSION_DOMAIN];

/** 域 → 动作码清单。用于角色配置页按域分组勾选，避免后端返回的平铺列表难读。 */
export const OPS_PERMISSIONS_BY_DOMAIN: Readonly<
  Record<OpsPermissionDomain, readonly OpsPermission[]>
> = {
  'identity-audit': [
    OPS_PERMISSION.OVERVIEW_READ,
    OPS_PERMISSION.OPERATOR_READ,
    OPS_PERMISSION.OPERATOR_MANAGE,
    OPS_PERMISSION.ROLE_MANAGE,
    OPS_PERMISSION.SETTINGS_MANAGE,
    OPS_PERMISSION.AUDIT_READ,
    OPS_PERMISSION.EXPORT_READ,
    OPS_PERMISSION.EXPORT_CREATE,
  ],
  customer: [
    OPS_PERMISSION.CUSTOMER_READ,
    OPS_PERMISSION.CUSTOMER_WRITE,
    OPS_PERMISSION.CUSTOMER_SENSITIVE_READ,
  ],
  catalog: [OPS_PERMISSION.CATALOG_READ, OPS_PERMISSION.CATALOG_WRITE],
  contract: [
    OPS_PERMISSION.CONTRACT_READ,
    OPS_PERMISSION.CONTRACT_WRITE,
    OPS_PERMISSION.CONTRACT_APPROVE,
  ],
  billing: [
    OPS_PERMISSION.RECEIVABLE_READ,
    OPS_PERMISSION.RECEIVABLE_WRITE,
    OPS_PERMISSION.RECEIPT_RECORD,
    OPS_PERMISSION.RECEIPT_APPROVE,
    OPS_PERMISSION.RECEIPT_RECONCILE,
    OPS_PERMISSION.RECEIPT_REVERSE,
    OPS_PERMISSION.RECEIPT_REFUND,
  ],
  entitlement: [
    OPS_PERMISSION.ENTITLEMENT_READ,
    OPS_PERMISSION.ENTITLEMENT_REQUEST,
    OPS_PERMISSION.ENTITLEMENT_APPROVE,
    OPS_PERMISSION.ENTITLEMENT_EXECUTE,
  ],
  'tenant-integration': [
    OPS_PERMISSION.TENANT_READ,
    OPS_PERMISSION.TENANT_PROVISION,
    OPS_PERMISSION.TENANT_SUSPEND,
    OPS_PERMISSION.TENANT_RESTORE,
    OPS_PERMISSION.TENANT_RETRY,
  ],
  deployment: [OPS_PERMISSION.DEPLOYMENT_READ, OPS_PERMISSION.DEPLOYMENT_WRITE],
  support: [
    OPS_PERMISSION.TICKET_READ,
    OPS_PERMISSION.TICKET_CREATE,
    OPS_PERMISSION.TICKET_ASSIGN,
    OPS_PERMISSION.TICKET_UPDATE,
    OPS_PERMISSION.TICKET_CLOSE,
  ],
};

/** 人类可读的动作说明，用于角色配置页与审计详情。与契约文档 §4 表格逐条对应。 */
export const OPS_PERMISSION_LABEL: Readonly<Record<OpsPermission, string>> = {
  [OPS_PERMISSION.OVERVIEW_READ]: '查看运营总览与下钻指标',
  [OPS_PERMISSION.OPERATOR_READ]: '查看运营账号与角色',
  [OPS_PERMISSION.OPERATOR_MANAGE]: '邀请/禁用账号、分配角色',
  [OPS_PERMISSION.ROLE_MANAGE]: '创建角色、编辑角色权限',
  [OPS_PERMISSION.SETTINGS_MANAGE]: '系统设置、字典维护',
  [OPS_PERMISSION.AUDIT_READ]: '查询审计事件',
  [OPS_PERMISSION.EXPORT_READ]: '查看导出任务与下载结果',
  [OPS_PERMISSION.EXPORT_CREATE]: '发起数据导出',
  [OPS_PERMISSION.CUSTOMER_READ]: '查看客户、联系人（联系方式掩码）',
  [OPS_PERMISSION.CUSTOMER_WRITE]: '新建/编辑/停用客户与联系人',
  [OPS_PERMISSION.CUSTOMER_SENSITIVE_READ]: '查看联系人电话/邮箱原值',
  [OPS_PERMISSION.CATALOG_READ]: '查看产品、套餐、价格版本、功能键',
  [OPS_PERMISSION.CATALOG_WRITE]: '维护产品/套餐/价格版本/功能键/套餐权益',
  [OPS_PERMISSION.CONTRACT_READ]: '查看合同、条目、版本、附件列表',
  [OPS_PERMISSION.CONTRACT_WRITE]: '草拟/编辑/提交/续约发起/变更单提交',
  [OPS_PERMISSION.CONTRACT_APPROVE]: '签署确认、生效、终止、变更单批准',
  [OPS_PERMISSION.RECEIVABLE_READ]:
    '查看应收计划、收款、核销、退款、导出账款明细',
  [OPS_PERMISSION.RECEIVABLE_WRITE]: '生成/调整应收计划、展期',
  [OPS_PERMISSION.RECEIPT_RECORD]: '登记线下收款',
  [OPS_PERMISSION.RECEIPT_APPROVE]: '审核/驳回收款登记（审核后计入实收）',
  [OPS_PERMISSION.RECEIPT_RECONCILE]: '核销收款到应收',
  [OPS_PERMISSION.RECEIPT_REVERSE]: '撤销核销、收款冲正',
  [OPS_PERMISSION.RECEIPT_REFUND]: '登记退款',
  [OPS_PERMISSION.ENTITLEMENT_READ]: '查看订阅、授权、权益快照、变更历史',
  [OPS_PERMISSION.ENTITLEMENT_REQUEST]: '创建订阅/授权草案、提交权益变更申请',
  [OPS_PERMISSION.ENTITLEMENT_APPROVE]: '审核权益变更申请',
  [OPS_PERMISSION.ENTITLEMENT_EXECUTE]: '执行已批准的权益变更并下发同步命令',
  [OPS_PERMISSION.TENANT_READ]: '查看租户映射、命令状态、尝试记录',
  [OPS_PERMISSION.TENANT_PROVISION]: '创建/绑定租户映射并发起开通',
  [OPS_PERMISSION.TENANT_SUSPEND]: '暂停租户',
  [OPS_PERMISSION.TENANT_RESTORE]: '恢复租户',
  [OPS_PERMISSION.TENANT_RETRY]: '重试失败命令',
  [OPS_PERMISSION.DEPLOYMENT_READ]: '查看部署实例与升级历史',
  [OPS_PERMISSION.DEPLOYMENT_WRITE]: '维护实例、登记升级结果、变更环境状态',
  [OPS_PERMISSION.TICKET_READ]: '查看工单与时间线',
  [OPS_PERMISSION.TICKET_CREATE]: '创建工单',
  [OPS_PERMISSION.TICKET_ASSIGN]: '分派/改派工单',
  [OPS_PERMISSION.TICKET_UPDATE]: '处理说明、等待、解决、编辑工单字段',
  [OPS_PERMISSION.TICKET_CLOSE]: '关闭工单、重开工单',
};

/** 判断动作码是否属于高风险，决定是否强制二次确认与填写原因。 */
export function isHighRiskPermission(permission: OpsPermission): boolean {
  return OPS_HIGH_RISK_PERMISSIONS.has(permission);
}

/**
 * 判断前端收到的权限集合是否含后端未知动作码。
 * 用途：契约漂移告警——后端新增动作而前端未同步时，应在控制台提示而不是静默忽略。
 */
export function findUnknownPermissions(granted: readonly string[]): string[] {
  const known = new Set<string>(OPS_PERMISSION_CODES);
  return granted.filter((code) => !known.has(code));
}
