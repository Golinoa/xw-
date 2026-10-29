import type { SupplierSettlement, SupplierType } from '@erp/contracts';

/** 供应商类型与结算方式的中文文案；枚举是机器值，文案只在这里维护。 */
export const SUPPLIER_TYPE_LABELS: Record<SupplierType, string> = {
  hotel: '酒店',
  transport: '交通',
  restaurant: '餐厅',
  ticket: '门票',
  other: '其他',
};

export const SUPPLIER_SETTLEMENT_LABELS: Record<SupplierSettlement, string> = {
  monthly: '月结',
  per_trip: '单团结算',
};

export const SUPPLIER_TYPE_OPTIONS = (
  ['hotel', 'transport', 'restaurant', 'ticket', 'other'] as const
).map((type) => ({ value: type, label: SUPPLIER_TYPE_LABELS[type] }));

export const SUPPLIER_SETTLEMENT_OPTIONS = (['monthly', 'per_trip'] as const).map((settlement) => ({
  value: settlement,
  label: SUPPLIER_SETTLEMENT_LABELS[settlement],
}));
