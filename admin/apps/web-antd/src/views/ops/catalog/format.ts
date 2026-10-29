/**
 * catalog 域展示层格式化与词表映射。
 *
 * 金额口径（契约 §2.2）：后端 `numeric(14,2)` → JSON `number`（2 位小数），
 * 前端**只格式化不换算**——不做币种换算、不做分/元转换、不累加。
 */
import type {
  FeatureAppliesTo,
  FeatureValueType,
  PackageBillingType,
  PackageStatus,
  ProductLifecycleStatus,
  SalesMode,
} from '#/api/ops/catalog';

export const PRODUCT_LIFECYCLE_LABEL: Readonly<
  Record<ProductLifecycleStatus, string>
> = {
  active: '在售',
  draft: '草稿',
  retired: '已停用',
};

export const PRODUCT_LIFECYCLE_COLOR: Readonly<
  Record<ProductLifecycleStatus, string>
> = {
  active: 'success',
  draft: 'default',
  retired: 'error',
};

/** [推导] 套餐状态取值未在契约枚举，见 `api/ops/catalog/README.md`。 */
export const PACKAGE_STATUS_LABEL: Readonly<Record<PackageStatus, string>> = {
  active: '在售',
  draft: '草稿',
  retired: '已停售',
};

export const PACKAGE_STATUS_COLOR: Readonly<Record<PackageStatus, string>> = {
  active: 'success',
  draft: 'default',
  retired: 'error',
};

export const BILLING_TYPE_LABEL: Readonly<Record<PackageBillingType, string>> =
  {
    fixed_term: '固定期限授权',
    one_time: '一次性授权',
    periodic: '周期订阅',
  };

export const SALES_MODE_LABEL: Readonly<Record<SalesMode, string>> = {
  private: '私有化',
  saas: 'SaaS',
};

export const FEATURE_VALUE_TYPE_LABEL: Readonly<
  Record<FeatureValueType, string>
> = {
  boolean: '开关',
  quota: '数值额度',
  term: '期限',
};

export const FEATURE_APPLIES_TO_LABEL: Readonly<
  Record<FeatureAppliesTo, string>
> = {
  both: 'SaaS + 私有化',
  private_instance: '仅私有化实例',
  saas_tenant: '仅 SaaS 租户',
};

/** 未知枚举降级显示，避免后端加法变更导致渲染崩溃（契约 §2.6）。 */
export function enumLabel<T extends string>(
  dictionary: Readonly<Record<T, string>>,
  value: string,
): string {
  return dictionary[value as T] ?? `未知(${value})`;
}

/**
 * 金额格式化：`number` → 带币种符号的两位小数字符串。
 *
 * 只做展示；不四舍五入业务计算值（后端已 `roundTo2`），`Intl` 的
 * `minimumFractionDigits` 保证「128000」显示为「¥128,000.00」而不是「¥128,000」。
 */
export function formatMoney(amount: number, currency = 'CNY'): string {
  if (!Number.isFinite(amount)) {
    return '—';
  }
  try {
    return new Intl.NumberFormat('zh-CN', {
      currency,
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
      style: 'currency',
    }).format(amount);
  } catch {
    // 非法币种代码：退化为数字 + 原币种码，不静默改币种
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** 契约 §2.2：`numeric(14,2)` 的上限。 */
export const AMOUNT_MAX = 999_999_999_999.99;

/**
 * 金额值域校验（0 – `AMOUNT_MAX`，最多 2 位小数）。
 *
 * 与后端 zod 校验同口径；仅用于表单提示，真实校验仍在服务端。
 */
export function isValidAmount(amount: null | number | undefined): boolean {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return false;
  }
  if (amount < 0 || amount > AMOUNT_MAX) {
    return false;
  }
  // 最多 2 位小数：浮点乘法有 1e-10 级误差，容忍 1e-6 再判断
  const cents = amount * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6;
}

/** 价格版本标题：页面必须能看出「这是哪个版本的价格」（实施计划要求）。 */
export function priceVersionLabel(
  versionNo: null | number | undefined,
): string {
  return versionNo === null || versionNo === undefined
    ? '无价格版本'
    : `价格版本 v${versionNo}`;
}

export function formatDate(value: null | string | undefined): string {
  return value ? value.slice(0, 10) : '—';
}

export function formatDateTime(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
