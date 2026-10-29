import type { CustomerIdType } from '@erp/contracts';

/** 证件类型的界面文案与契约枚举分开维护：枚举是稳定机器值，文案随时可改。 */
export const CUSTOMER_ID_TYPE_LABELS: Record<CustomerIdType, string> = {
  id_card: '身份证',
  passport: '护照',
  other: '其他证件',
};

export function formatCustomerIdType(value: CustomerIdType | undefined): string {
  return value ? CUSTOMER_ID_TYPE_LABELS[value] : '—';
}

/** 时间格式化已统一到 `lib/format`，这里转出以保持客户相关组件的导入入口不变。 */
export { formatDateTime } from '../../lib/format';
