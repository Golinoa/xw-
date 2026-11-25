import {
  FINANCE_APPLICATION_STATUSES,
  type FinanceApplicationItem,
  type FinanceApplicationKind,
  type FinanceApplicationStatus,
  PAYMENT_METHODS,
  type PaymentMethod,
  type Permission,
  PERMISSIONS,
} from '@erp/contracts';

/**
 * 只回答两件事：「机器值怎么显示」和「按钮该不该出现」。
 * 金额、状态、级次以服务端为准，前端不推断。按钮可见性不是权限，只是少给点错机会。
 */

export const APPLICATION_KIND_LABEL_KEYS: Record<FinanceApplicationKind, string> = {
  receipt: 'shell.applications.kindReceipt',
  payment: 'shell.applications.kindPayment',
};

export const APPLICATION_KINDS: readonly FinanceApplicationKind[] = ['receipt', 'payment'];

export const APPLICATION_STATUS_LABEL_KEYS: Record<FinanceApplicationStatus, string> = {
  pending: 'shell.applications.statusPending',
  approved: 'shell.applications.statusApproved',
  rejected: 'shell.applications.statusRejected',
  withdrawn: 'shell.applications.statusWithdrawn',
};

export const APPLICATION_STATUS_TAG_COLORS: Record<FinanceApplicationStatus, string> = {
  pending: 'orange',
  approved: 'green',
  rejected: 'red',
  withdrawn: 'default',
};

/** 「全部状态」只在界面存在，契约 status 是四枚举值，发请求前必须去掉。 */
export type ApplicationStatusFilter = 'all' | FinanceApplicationStatus;

export const APPLICATION_STATUS_FILTERS: readonly ApplicationStatusFilter[] = [
  'all',
  ...FINANCE_APPLICATION_STATUSES,
];

export const PAYMENT_METHOD_LABEL_KEYS: Record<PaymentMethod, string> = {
  cash: 'shell.applications.methodCash',
  bank: 'shell.applications.methodBank',
  alipay: 'shell.applications.methodAlipay',
  wechat: 'shell.applications.methodWechat',
  other: 'shell.applications.methodOther',
};

export const PAYMENT_METHODS_ORDER: readonly PaymentMethod[] = PAYMENT_METHODS;

export function isApplicationKind(value: string): value is FinanceApplicationKind {
  return value === 'receipt' || value === 'payment';
}

export function isStatusFilter(value: string): value is ApplicationStatusFilter {
  return value === 'all' || (FINANCE_APPLICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * 待到哪一级。已终审/已结束的申请不显示级次：那时 currentStep 只说明最后停在哪一步，
 * 摆一个「第 2 级」在已驳回的记录上会让人以为还在等谁。
 */
export function applicationStageLabelKey(item: FinanceApplicationItem): string {
  if (item.status !== 'pending') return '';
  return item.currentStep === 1 ? 'shell.applications.stepFinance' : 'shell.applications.stepAdmin';
}

export function hasPermission(permissions: readonly Permission[], permission: Permission): boolean {
  return permissions.includes(permission);
}

/**
 * 能不能审批这一条：状态待审 + 有 finance.approve + 不是自己提交的。
 * 服务端会拒绝自审（SELF_APPROVAL_FORBIDDEN），前端也挡一下，别让人点开才被拒。
 */
export function canDecide(
  item: FinanceApplicationItem,
  permissions: readonly Permission[],
  currentUserId: null | string,
): boolean {
  if (item.status !== 'pending') return false;
  if (!hasPermission(permissions, PERMISSIONS.FINANCE_APPROVE)) return false;
  return item.createdBy === null || item.createdBy !== currentUserId;
}

/** 撤回只给创建人，且只对待审有效。 */
export function canWithdraw(item: FinanceApplicationItem, currentUserId: null | string): boolean {
  return item.status === 'pending' && item.createdBy !== null && item.createdBy === currentUserId;
}

/** 撤销终审只对已通过的申请，要求审批权限（管理员校验在库函数里）。 */
export function canUndo(
  item: FinanceApplicationItem,
  permissions: readonly Permission[],
): boolean {
  return item.status === 'approved' && hasPermission(permissions, PERMISSIONS.FINANCE_APPROVE);
}

export function hasRowActions(
  item: FinanceApplicationItem,
  permissions: readonly Permission[],
  currentUserId: null | string,
): boolean {
  return (
    canDecide(item, permissions, currentUserId) ||
    canWithdraw(item, currentUserId) ||
    canUndo(item, permissions)
  );
}

/** 隐私：只区分「你/其他成员」，不暴露申请人姓名。 */
export function applicantLabelKey(
  item: FinanceApplicationItem,
  currentUserId: null | string,
): string {
  if (!item.createdBy) return 'shell.applications.applicantNone';
  return item.createdBy === currentUserId
    ? 'shell.applications.applicantYou'
    : 'shell.applications.applicantOther';
}
