import type { CustomerIdType } from '@erp/contracts';

/**
 * 证件类型的文案键。枚举是稳定机器值，文案随时可改，所以只维护键。
 */
export const CUSTOMER_ID_TYPE_LABEL_KEYS: Record<CustomerIdType, string> = {
  id_card: 'shell.customers.idTypeIdCard',
  other: 'shell.customers.idTypeOther',
  passport: 'shell.customers.idTypePassport',
};

/** 枚举顺序固定，避免下拉选项顺序随对象字面量书写顺序漂移。 */
export const CUSTOMER_ID_TYPE_ORDER: CustomerIdType[] = ['id_card', 'passport', 'other'];
