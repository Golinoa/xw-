import {
  ORDER_STATUSES,
  ORDER_TYPES,
  type OrderAction,
  type OrderStatus,
  type OrderType,
} from '@erp/contracts';

/** 枚举值 → i18n 文案键。机器值稳定，文案只改 shell.json。 */
export const ORDER_STATUS_LABEL_KEYS: Record<OrderStatus, string> = {
  booking: 'shell.orders.statusBooking',
  active: 'shell.orders.statusActive',
  completed: 'shell.orders.statusCompleted',
  cancelled: 'shell.orders.statusCancelled',
};

export const ORDER_STATUS_TAG_COLORS: Record<OrderStatus, string> = {
  booking: 'gold',
  active: 'blue',
  completed: 'green',
  cancelled: 'default',
};

export const ORDER_TYPE_LABEL_KEYS: Record<OrderType, string> = {
  active: 'shell.orders.typeActive',
  booking: 'shell.orders.typeBooking',
};

export const ORDER_ACTION_LABEL_KEYS: Record<OrderAction, string> = {
  confirm: 'shell.orders.actionConfirm',
  revert: 'shell.orders.actionRevert',
  lock: 'shell.orders.actionLock',
  unlock: 'shell.orders.actionUnlock',
  cancel: 'shell.orders.actionCancel',
  restore: 'shell.orders.actionRestore',
};

/** 与服务端 transition_order_status 的合法迁移表一致；非法动作仍由服务端拒绝。 */
const ORDER_ACTIONS_BY_STATUS: Record<OrderStatus, readonly OrderAction[]> = {
  booking: ['confirm'],
  active: ['revert', 'lock', 'cancel'],
  completed: ['unlock'],
  cancelled: ['restore'],
};

export function availableOrderActions(status: OrderStatus): readonly OrderAction[] {
  return ORDER_ACTIONS_BY_STATUS[status];
}

/** 契约要求这三个动作必须带原因，服务端同样校验。 */
const ORDER_ACTIONS_REQUIRING_REASON: readonly OrderAction[] = ['lock', 'unlock', 'cancel'];

export function requiresReason(action: OrderAction): boolean {
  return (ORDER_ACTIONS_REQUIRING_REASON as readonly string[]).includes(action);
}

/** 动作后果文案键：这些动作都改业务状态，且多数不可逆。 */
export const ORDER_ACTION_EFFECT_KEYS: Record<OrderAction, string> = {
  confirm: 'shell.orders.effectConfirm',
  revert: 'shell.orders.effectRevert',
  lock: 'shell.orders.effectLock',
  unlock: 'shell.orders.effectUnlock',
  cancel: 'shell.orders.effectCancel',
  restore: 'shell.orders.effectRestore',
};

export const ORDER_STATUS_OPTIONS = ORDER_STATUSES.map((status) => ({
  value: status,
  labelKey: ORDER_STATUS_LABEL_KEYS[status],
}));

export const ORDER_TYPE_OPTIONS = ORDER_TYPES.map((type) => ({
  value: type,
  labelKey: ORDER_TYPE_LABEL_KEYS[type],
}));

/** 已锁团/已取消的服务端禁止编辑（ORDER_STATE_CONFLICT），入口同步禁用。 */
export function isEditable(status: OrderStatus): boolean {
  return status === 'booking' || status === 'active';
}
