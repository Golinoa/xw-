import type { SupplierSettlement, SupplierType } from '@erp/contracts';

/**
 * 供应商枚举的文案键。
 *
 * 值只在这里维护：`Select` 选项与表格列取同一份，改文案不会出现
 * 「列表说『单团结算』、表单说『按团结算』」。
 */
export const SUPPLIER_TYPE_LABEL_KEYS: Record<SupplierType, string> = {
  hotel: 'shell.suppliers.typeHotel',
  other: 'shell.suppliers.typeOther',
  restaurant: 'shell.suppliers.typeRestaurant',
  ticket: 'shell.suppliers.typeTicket',
  transport: 'shell.suppliers.typeTransport',
};

export const SUPPLIER_SETTLEMENT_LABEL_KEYS: Record<SupplierSettlement, string> = {
  monthly: 'shell.suppliers.settlementMonthly',
  per_trip: 'shell.suppliers.settlementPerTrip',
};

/** 枚举顺序固定，避免选项顺序随对象字面量书写顺序漂移。 */
export const SUPPLIER_TYPE_ORDER: SupplierType[] = [
  'hotel',
  'transport',
  'restaurant',
  'ticket',
  'other',
];

export const SUPPLIER_SETTLEMENT_ORDER: SupplierSettlement[] = ['per_trip', 'monthly'];

/** 表格里的「—」：字段没填就是没填，不要拿空字符串假装有值。 */
export { displayText } from '#/lib/format';
