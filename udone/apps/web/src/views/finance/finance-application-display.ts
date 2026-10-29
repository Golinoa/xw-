import {
  FINANCE_APPLICATION_STATUSES,
  PAYMENT_METHODS,
  PERMISSIONS,
  type FinanceApplicationItem,
  type FinanceApplicationKind,
  type FinanceApplicationStatus,
  type PaymentMethod,
  type Permission,
} from '@erp/contracts';

/**
 * 收付款申请的展示层映射与动作可见性判断。
 *
 * 这里只回答两件事：「机器值怎么显示」和「这个按钮该不该出现」。
 * 金额、状态、级次都以服务端为准，页面不做推断。
 *
 * 按钮可见性只是界面提示，不是权限：服务端每个动作都有自己的权限中间件，
 * 库函数还有创建人校验与管理员校验。前端隐藏按钮是为了少给人点错的机会，
 * 不是为了安全。
 */

export const APPLICATION_KIND_LABELS: Record<FinanceApplicationKind, string> = {
  receipt: '收款',
  payment: '付款',
};

export const APPLICATION_KIND_OPTIONS = [
  { value: 'receipt', label: '收款申请' },
  { value: 'payment', label: '付款申请' },
];

export const APPLICATION_STATUS_LABELS: Record<FinanceApplicationStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
};

export const APPLICATION_STATUS_TAG_COLORS: Record<FinanceApplicationStatus, string> = {
  pending: 'orange',
  approved: 'green',
  rejected: 'red',
  withdrawn: 'default',
};

/** 「全部状态」只存在于界面：契约里 status 是四个枚举值，发请求前必须去掉。 */
export type ApplicationStatusFilter = FinanceApplicationStatus | 'all';

export const APPLICATION_STATUS_FILTER_OPTIONS: {
  value: ApplicationStatusFilter;
  label: string;
}[] = [
  { value: 'all', label: '全部状态' },
  ...FINANCE_APPLICATION_STATUSES.map((status) => ({
    value: status as ApplicationStatusFilter,
    label: APPLICATION_STATUS_LABELS[status],
  })),
];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: '现金',
  bank: '银行转账',
  alipay: '支付宝',
  wechat: '微信',
  other: '其他',
};

export const PAYMENT_METHOD_OPTIONS = PAYMENT_METHODS.map((method) => ({
  value: method,
  label: PAYMENT_METHOD_LABELS[method],
}));

export function isApplicationKind(value: string): value is FinanceApplicationKind {
  return value === 'receipt' || value === 'payment';
}

export function isApplicationStatus(value: string): value is FinanceApplicationStatus {
  return (FINANCE_APPLICATION_STATUSES as readonly string[]).includes(value);
}

export function isStatusFilter(value: string): value is ApplicationStatusFilter {
  return value === 'all' || isApplicationStatus(value);
}

/**
 * 待到哪一级。
 *
 * 已终审或已结束的申请不显示级次：那时的 `currentStep` 只说明「最后停在哪一步」，
 * 摆一个「第 2 级」在已驳回的记录上会让人以为还在等谁。
 */
export function applicationStageLabel(item: FinanceApplicationItem): string {
  if (item.status !== 'pending') return '—';
  return item.currentStep === 1 ? '待财务审批' : '待管理员终审';
}

/** 提交人只显示「你 / 其他成员」：profiles 的读策略不放开，读不到同事姓名。 */
export function applicantLabel(item: FinanceApplicationItem, currentUserId: string | null): string {
  if (!item.createdBy) return '—';
  if (!currentUserId) return '其他成员';
  return item.createdBy === currentUserId ? '你' : '其他成员';
}

export function hasPermission(permissions: readonly Permission[], permission: Permission): boolean {
  return permissions.includes(permission);
}

/**
 * 能不能审批这一条。
 *
 * 三个条件缺一不可：状态是待审、有 `finance.approve`、不是自己提交的。
 * 最后一条前端也要判断——服务端会拒绝（SELF_APPROVAL_FORBIDDEN），
 * 但让人点开审批框再被拒，体验上等于骗了一次。
 */
export function canDecide(
  item: FinanceApplicationItem,
  permissions: readonly Permission[],
  currentUserId: string | null,
): boolean {
  if (item.status !== 'pending') return false;
  if (!hasPermission(permissions, PERMISSIONS.FINANCE_APPROVE)) return false;
  return item.createdBy === null || item.createdBy !== currentUserId;
}

/** 撤回只给创建人，且只对待审有效。 */
export function canWithdraw(item: FinanceApplicationItem, currentUserId: string | null): boolean {
  return item.status === 'pending' && item.createdBy !== null && item.createdBy === currentUserId;
}

/** 撤销终审只对已通过的申请，且要求审批权限（管理员校验在库函数里）。 */
export function canUndo(item: FinanceApplicationItem, permissions: readonly Permission[]): boolean {
  return item.status === 'approved' && hasPermission(permissions, PERMISSIONS.FINANCE_APPROVE);
}

/** 列表行上的「操作」列是否有任何按钮，避免渲染一个空列。 */
export function hasRowActions(
  item: FinanceApplicationItem,
  permissions: readonly Permission[],
  currentUserId: string | null,
): boolean {
  return (
    canDecide(item, permissions, currentUserId) ||
    canWithdraw(item, currentUserId) ||
    canUndo(item, permissions)
  );
}

/**
 * 审批意见的必填规则：驳回必须写，通过可以不写。
 *
 * 与服务端契约里的 refine、库函数里的 REASON_REQUIRED 是同一条规则的三处实现。
 * 三处都留是刻意的：库里那一道保证数据，契约那一道保证 HTTP 语义，
 * 这一道保证用户当场知道要填什么。
 */
export function opinionRequired(action: 'approve' | 'reject'): boolean {
  return action === 'reject';
}
