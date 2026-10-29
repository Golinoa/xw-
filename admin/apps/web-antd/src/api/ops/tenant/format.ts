/**
 * 租户交付域展示映射：状态标签、命令类型、错误类别、时间格式。
 *
 * 原则（契约 §2.6）：未知枚举值降级为「未知(原值)」而不是空白——
 * 后端新增状态时页面不能出现「没有状态」的脏数据观感。
 */
import type {
  TenantCommandStatus,
  TenantCommandType,
  TenantErrorCategory,
  TenantMappingStatus,
} from './types';

import dayjs from 'dayjs';

const UNKNOWN_PREFIX = '未知';

export type TenantTagColor = 'blue' | 'default' | 'green' | 'orange' | 'red';

export interface StatusView {
  color: TenantTagColor;
  label: string;
}

const MAPPING_STATUS_LABEL: Readonly<Record<TenantMappingStatus, string>> = {
  active: '已开通',
  pending: '待开通',
  suspended: '已暂停',
  terminated: '已终止',
};

const MAPPING_STATUS_COLOR: Readonly<
  Record<TenantMappingStatus, TenantTagColor>
> = {
  active: 'green',
  pending: 'orange',
  suspended: 'red',
  terminated: 'default',
};

const COMMAND_STATUS_LABEL: Readonly<Record<TenantCommandStatus, string>> = {
  cancelled: '已取消',
  failed: '失败',
  pending: '待执行',
  retrying: '重试中',
  succeeded: '已成功',
};

const COMMAND_STATUS_COLOR: Readonly<
  Record<TenantCommandStatus, TenantTagColor>
> = {
  cancelled: 'default',
  failed: 'red',
  pending: 'orange',
  retrying: 'blue',
  succeeded: 'green',
};

const COMMAND_TYPE_LABEL: Readonly<Record<TenantCommandType, string>> = {
  activate: '激活租户',
  bind: '绑定租户',
  extend: '延期',
  provision: '开通租户',
  resume: '恢复租户',
  revoke: '撤销权益',
  suspend: '暂停租户',
  sync_entitlement: '同步权益',
};

const ERROR_CATEGORY_LABEL: Readonly<Record<TenantErrorCategory, string>> = {
  auth: '鉴权失败',
  conflict: '状态冲突',
  permanent: '永久性错误',
  transient: '暂时性错误',
  unknown: '未知错误',
};

const ERROR_CATEGORY_COLOR: Readonly<
  Record<TenantErrorCategory, TenantTagColor>
> = {
  auth: 'orange',
  conflict: 'orange',
  permanent: 'red',
  transient: 'orange',
  unknown: 'default',
};

const ATTEMPT_OUTCOME_LABEL: Readonly<Record<string, string>> = {
  failed: '失败',
  succeeded: '成功',
  timeout: '超时（结果未知）',
};

function withUnknown(
  value: string,
  table: Readonly<Record<string, string>>,
  colorTable: Readonly<Record<string, TenantTagColor>>,
  fallbackColor: TenantTagColor = 'default',
): StatusView & { known: boolean } {
  const known = Object.prototype.hasOwnProperty.call(table, value);
  return {
    color: known ? (colorTable[value] ?? fallbackColor) : fallbackColor,
    known,
    label: known ? (table[value] ?? value) : `${UNKNOWN_PREFIX}(${value})`,
  };
}

export function mappingStatusView(status: string): StatusView {
  return withUnknown(status, MAPPING_STATUS_LABEL, MAPPING_STATUS_COLOR);
}

export function commandStatusView(status: string): StatusView {
  return withUnknown(status, COMMAND_STATUS_LABEL, COMMAND_STATUS_COLOR);
}

export function errorCategoryView(category: string): StatusView {
  return withUnknown(category, ERROR_CATEGORY_LABEL, ERROR_CATEGORY_COLOR);
}

/** 命令类型展示名；未知类型保留原值，便于对照后端日志。 */
export function commandTypeLabel(type: string): string {
  return (
    COMMAND_TYPE_LABEL[type as TenantCommandType] ??
    `${UNKNOWN_PREFIX}(${type})`
  );
}

export function attemptOutcomeLabel(outcome: string): string {
  return ATTEMPT_OUTCOME_LABEL[outcome] ?? `${UNKNOWN_PREFIX}(${outcome})`;
}

/** 映射状态筛选下拉（契约 §3.6 四态）。 */
export const MAPPING_STATUS_OPTIONS = (
  ['pending', 'active', 'suspended', 'terminated'] as const
).map((value) => ({ label: MAPPING_STATUS_LABEL[value], value }));

/** 命令状态筛选下拉（契约 §3.6 五态）。 */
export const COMMAND_STATUS_OPTIONS = (
  ['pending', 'retrying', 'succeeded', 'failed', 'cancelled'] as const
).map((value) => ({ label: COMMAND_STATUS_LABEL[value], value }));

/** 命令类型筛选下拉。 */
export const COMMAND_TYPE_OPTIONS = (
  [
    'provision',
    'bind',
    'activate',
    'suspend',
    'resume',
    'sync_entitlement',
    'extend',
    'revoke',
  ] as const
).map((value) => ({ label: COMMAND_TYPE_LABEL[value], value }));

/** 时间戳按浏览器本地时区展示到分钟；后端返回 UTC ISO 8601（契约 §2.3）。 */
export function formatDateTime(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : '—';
}

/** 外部 ID / 幂等键等长串的统一短展示（完整值放 Tooltip 或详情）。 */
export function shortId(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
