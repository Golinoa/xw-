/**
 * 展示层格式化统一出口。
 *
 * 金额与时间只在这里拼字符串：列表、详情、表单摘要共用同一套规则，
 * 避免出现「列表 ¥1,000.5、详情 ¥1000.50」这类不一致。
 */

const amountFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * 金额：人民币符号 + 千分位 + 两位小数，负数把负号放在符号前（`-¥120.00`）。
 * 服务端 `numeric(14,2)` 已经是精确值，这里只格式化，不做任何再计算。
 */
export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}¥${amountFormatter.format(Math.abs(value))}`;
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
