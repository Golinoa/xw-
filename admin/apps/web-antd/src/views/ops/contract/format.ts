/**
 * contract 域展示层格式化与词表映射。
 *
 * 金额口径（契约 §2.2）：后端 `numeric(14,2)` → JSON `number`；前端只格式化，
 * 不做币种换算、不做累加（合同合计由服务端按条目复算，契约 §3.3）。
 */
import type {
  ContractBillingType,
  ContractSalesMode,
  ContractStatus,
  ContractTransitionAction,
} from '#/api/ops/contract';

export const CONTRACT_STATUS_LABEL: Readonly<Record<ContractStatus, string>> = {
  active: '生效中',
  draft: '草稿',
  expired: '已到期',
  reviewing: '审核中',
  signed: '已签署',
  terminated: '已终止',
};

export const CONTRACT_STATUS_COLOR: Readonly<Record<ContractStatus, string>> = {
  active: 'success',
  draft: 'default',
  expired: 'warning',
  reviewing: 'processing',
  signed: 'blue',
  terminated: 'error',
};

export const CONTRACT_ACTION_LABEL: Readonly<
  Record<ContractTransitionAction, string>
> = {
  activate: '确认生效',
  expire: '标记到期',
  sign: '签署确认',
  submit: '提交审核',
  terminate: '终止合同',
  withdraw: '撤回审核',
};

export const CONTRACT_ACTION_HINT: Readonly<
  Record<ContractTransitionAction, string>
> = {
  activate: '生效后写入合同版本快照与条目权益快照，核心条款不可再直接修改。',
  expire: '标记到期不改变历史版本；续约需新建合同并关联原合同。',
  sign: '签署确认代表合同已由双方签署，此后不可静默覆盖。',
  submit: '提交后进入审核中，仍可撤回；至少需要一条条目。',
  terminate: '终止需填写原因，并会检查应收、订阅/授权与租户命令影响。',
  withdraw: '撤回到草稿后可继续编辑条目。',
};

/** 需要 `contract.approve` 的动作（契约 §5.4、§4 高风险清单）。 */
export const CONTRACT_APPROVE_ACTIONS: ReadonlySet<ContractTransitionAction> =
  new Set(['activate', 'expire', 'sign', 'terminate']);

/** 需要填写日期的动作（契约 §3.3 守卫）。 */
export const CONTRACT_ACTION_DATE_FIELD: Readonly<
  Partial<Record<ContractTransitionAction, 'effectiveOn' | 'signedOn'>>
> = {
  activate: 'effectiveOn',
  sign: 'signedOn',
};

export const SALES_MODE_LABEL: Readonly<Record<ContractSalesMode, string>> = {
  private: '私有化',
  saas: 'SaaS',
};

export const BILLING_TYPE_LABEL: Readonly<Record<ContractBillingType, string>> =
  {
    fixed_term: '固定期限授权',
    one_time: '一次性授权',
    periodic: '周期订阅',
  };

export function enumLabel<T extends string>(
  dictionary: Readonly<Record<T, string>>,
  value: string,
): string {
  return dictionary[value as T] ?? `未知(${value})`;
}

/**
 * 金额格式化（只展示，不换算）。
 * `minimumFractionDigits: 2` 保证「396000」显示为「¥396,000.00」。
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
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatDate(value: null | string | undefined): string {
  return value ? value.slice(0, 10) : '—';
}

/** 价格版本标题：合同条目必须能看出「按哪一版价格签约」。 */
export function priceVersionLabel(
  versionNo: null | number | undefined,
): string {
  return versionNo === null || versionNo === undefined
    ? '无价格版本'
    : `价格版本 v${versionNo}`;
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

/** 附件大小展示（契约 §3.3：`byte_size` ≤ 25 MiB）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
