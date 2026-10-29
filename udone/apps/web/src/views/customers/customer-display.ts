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

/** 时间按本地时区展示；服务端返回的是 ISO 字符串，非法值原样回显而不是显示 Invalid Date。 */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
