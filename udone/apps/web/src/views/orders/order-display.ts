import {
  ORDER_STATUSES,
  ORDER_TYPES,
  type OrderAction,
  type OrderStatus,
  type OrderType,
} from '@erp/contracts';

/**
 * 订单枚举的中文映射。枚举是稳定机器值，文案只改这里。
 *
 * 两个维度分开看：
 * - `orderType`：`booking` = 预订单，`active` = 正式订单（预订单确认出团后类型才变成 active）。
 * - `status`：`booking` = 待确认（尚未确认出团），`active` = 进行中，
 *   `completed` = 已锁团（数据库 `lock` 动作的目标状态，不是「订单已完成」），
 *   `cancelled` = 已取消。
 * 因此「预订单/待确认」都来自 `booking` 这个取值，但分属类型与状态两个字段。
 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  booking: '待确认',
  active: '进行中',
  completed: '已锁团',
  cancelled: '已取消',
};

/** 状态标签取 Ant Design 语义色名，不写死色值；`default` 是内置中性样式。 */
export const ORDER_STATUS_TAG_COLORS: Record<OrderStatus, string> = {
  booking: 'gold',
  active: 'blue',
  completed: 'green',
  cancelled: 'default',
};

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  active: '正式订单',
  booking: '预订单',
};

export const ORDER_ACTION_LABELS: Record<OrderAction, string> = {
  confirm: '确认出团',
  revert: '转回预订单',
  lock: '锁团',
  unlock: '解锁',
  cancel: '取消订单',
  restore: '恢复订单',
};

/**
 * 每个状态可用的动作，与数据库 `transition_order_status` 的合法迁移表一致
 * （booking→active、active→booking/completed/cancelled、completed→active、cancelled→原状态）。
 * 前端只做入口收敛，非法动作仍由服务端拒绝。
 */
const ORDER_ACTIONS_BY_STATUS: Record<OrderStatus, readonly OrderAction[]> = {
  booking: ['confirm'],
  active: ['revert', 'lock', 'cancel'],
  completed: ['unlock'],
  cancelled: ['restore'],
};

export function availableOrderActions(status: OrderStatus): readonly OrderAction[] {
  return ORDER_ACTIONS_BY_STATUS[status];
}

/** 契约 `transitionOrderRequestSchema` 要求这三个动作必须带原因，服务端同样会校验。 */
const ORDER_ACTIONS_REQUIRING_REASON: readonly OrderAction[] = ['lock', 'unlock', 'cancel'];

export function requiresReason(action: OrderAction): boolean {
  return ORDER_ACTIONS_REQUIRING_REASON.includes(action);
}

/** 弹窗里必须写清动作后果：这些动作都会改业务状态，且多数不可逆。 */
export const ORDER_ACTION_EFFECTS: Record<OrderAction, string> = {
  confirm: '确认后订单从「待确认」变为「进行中」，之后才可以锁团。',
  revert: '转回后订单回到「待确认」，需要重新确认出团。',
  lock: '锁团后订单变为「已锁团」，客户、线路与金额都不能再编辑，必须先解锁。',
  unlock: '解锁后订单回到「进行中」，可以继续编辑。',
  cancel: '取消后订单不能编辑，只能用「恢复订单」回到取消前的状态。',
  restore: '恢复后订单回到取消前的状态（未记录时默认回到「进行中」）。',
};

export const ORDER_STATUS_OPTIONS = ORDER_STATUSES.map((status) => ({
  value: status,
  label: ORDER_STATUS_LABELS[status],
}));

export const ORDER_TYPE_OPTIONS = ORDER_TYPES.map((type) => ({
  value: type,
  label: ORDER_TYPE_LABELS[type],
}));
