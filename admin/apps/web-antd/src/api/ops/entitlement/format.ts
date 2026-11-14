/**
 * 权益域展示映射：状态标签、变更类型、授权方式、额度格式化。
 *
 * 原则（`Docs/ops-api-contract.md` §2.6）：未知枚举值必须降级为「未知(原值)」，
 * 不能渲染空白——后端加法式新增状态时页面不应出现「没有状态」的脏数据观感。
 *
 * 额度 `quota`（`numeric(14,2)`）只格式化、不运算（§2.2 的前端侧约束）。
 */
import type {
  BillingCycle,
  ChangeRequestStatus,
  ChangeRequestType,
  EntitlementActorRef,
  EntitlementStatus,
  EntitlementSubjectType,
  License,
  LicenseMode,
  SnapshotSummary,
} from './types';

import dayjs from 'dayjs';

/** 未知枚举的展示前缀。 */
const UNKNOWN_PREFIX = '未知';

/** Tag 颜色（ant-design-vue 语义色）。 */
export type OpsTagColor = 'blue' | 'default' | 'green' | 'orange' | 'red';

export interface StatusView {
  color: OpsTagColor;
  /** 是否为已知枚举；未知值用于在界面上同时提示契约漂移。 */
  known: boolean;
  label: string;
}

const STATUS_LABEL: Readonly<Record<EntitlementStatus, string>> = {
  active: '生效中',
  draft: '草稿',
  expired: '已到期',
  pending_approval: '待审批',
  revoked: '已撤销',
  suspended: '已暂停',
};

const STATUS_COLOR: Readonly<Record<EntitlementStatus, OpsTagColor>> = {
  active: 'green',
  draft: 'default',
  expired: 'default',
  pending_approval: 'orange',
  revoked: 'red',
  suspended: 'orange',
};

const BILLING_CYCLE_LABEL: Readonly<Record<BillingCycle, string>> = {
  monthly: '按月',
  multi_year: '多年',
  quarterly: '按季',
  yearly: '按年',
};

const LICENSE_MODE_LABEL: Readonly<Record<LicenseMode, string>> = {
  perpetual: '永久授权',
  term: '限期授权',
};

const CHANGE_STATUS_LABEL: Readonly<Record<ChangeRequestStatus, string>> = {
  approved: '已审批待执行',
  cancelled: '已取消',
  draft: '草稿',
  executed: '已执行',
  executing: '执行中',
  failed: '执行失败',
  pending_approval: '待审批',
  rejected: '已驳回',
};

const CHANGE_STATUS_COLOR: Readonly<Record<ChangeRequestStatus, OpsTagColor>> =
  {
    approved: 'blue',
    cancelled: 'default',
    draft: 'default',
    executed: 'green',
    executing: 'blue',
    failed: 'red',
    pending_approval: 'orange',
    rejected: 'default',
  };

const CHANGE_TYPE_LABEL: Readonly<Record<ChangeRequestType, string>> = {
  downgrade: '降级（缩权）',
  expire: '到期',
  extend: '延期',
  issue: '新发',
  quota_change: '额度变更',
  resume: '恢复',
  revoke: '撤销授权',
  suspend: '暂停',
  upgrade: '升级',
};

function withUnknown(
  value: string,
  table: Readonly<Record<string, string>>,
  colorTable: Readonly<Record<string, OpsTagColor>>,
  fallbackColor: OpsTagColor = 'default',
): StatusView {
  const known = Object.prototype.hasOwnProperty.call(table, value);
  return {
    color: known ? (colorTable[value] ?? fallbackColor) : fallbackColor,
    known,
    label: known ? (table[value] ?? value) : `${UNKNOWN_PREFIX}(${value})`,
  };
}

export function entitlementStatusView(status: string): StatusView {
  return withUnknown(status, STATUS_LABEL, STATUS_COLOR);
}

export function changeRequestStatusView(status: string): StatusView {
  return withUnknown(status, CHANGE_STATUS_LABEL, CHANGE_STATUS_COLOR);
}

export function billingCycleLabel(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  return (
    BILLING_CYCLE_LABEL[value as BillingCycle] ?? `${UNKNOWN_PREFIX}(${value})`
  );
}

export function licenseModeLabel(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  return (
    LICENSE_MODE_LABEL[value as LicenseMode] ?? `${UNKNOWN_PREFIX}(${value})`
  );
}

export function licenseModeView(value: null | string | undefined): StatusView {
  if (!value) {
    return { color: 'default', known: false, label: '—' };
  }
  const known = Object.prototype.hasOwnProperty.call(LICENSE_MODE_LABEL, value);
  return {
    color: value === 'perpetual' ? 'blue' : 'default',
    known,
    label: known
      ? (LICENSE_MODE_LABEL[value as LicenseMode] ?? value)
      : `${UNKNOWN_PREFIX}(${value})`,
  };
}

export function changeTypeLabel(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  return (
    CHANGE_TYPE_LABEL[value as ChangeRequestType] ??
    `${UNKNOWN_PREFIX}(${value})`
  );
}

export function subjectTypeLabel(value: null | string | undefined): string {
  if (value === 'subscription') {
    return 'SaaS 订阅';
  }
  if (value === 'license') {
    return '私有授权';
  }
  return value ? `${UNKNOWN_PREFIX}(${value})` : '—';
}

export const ENTITLEMENT_STATUS_OPTIONS = (
  [
    'draft',
    'pending_approval',
    'active',
    'suspended',
    'expired',
    'revoked',
  ] as const
).map((value) => ({ label: STATUS_LABEL[value], value }));

export const BILLING_CYCLE_OPTIONS = (
  ['monthly', 'quarterly', 'yearly', 'multi_year'] as const
).map((value) => ({ label: BILLING_CYCLE_LABEL[value], value }));

export const LICENSE_MODE_OPTIONS = (['term', 'perpetual'] as const).map(
  (value) => ({ label: LICENSE_MODE_LABEL[value], value }),
);

export const CHANGE_REQUEST_STATUS_OPTIONS = (
  [
    'draft',
    'pending_approval',
    'approved',
    'executing',
    'executed',
    'failed',
    'rejected',
    'cancelled',
  ] as const
).map((value) => ({ label: CHANGE_STATUS_LABEL[value], value }));

/** 变更类型选项：`issue` 只用于首次发放，其余用于生效后的变更。 */
export const CHANGE_REQUEST_TYPE_OPTIONS = (
  [
    'issue',
    'extend',
    'upgrade',
    'downgrade',
    'quota_change',
    'suspend',
    'resume',
    'expire',
    'revoke',
  ] as const
).map((value) => ({ label: CHANGE_TYPE_LABEL[value], value }));

export const SUBJECT_TYPE_OPTIONS: {
  label: string;
  value: EntitlementSubjectType;
}[] = [
  { label: 'SaaS 订阅', value: 'subscription' },
  { label: '私有授权', value: 'license' },
];

/**
 * 操作者归一化：契约表格列是 `uuid`，展示需要姓名。
 * 取不到姓名时退回 id 前 8 位，绝不渲染空字符串。
 */
export function actorId(
  actor: EntitlementActorRef | null | undefined,
): null | string {
  if (actor === null || actor === undefined) {
    return null;
  }
  if (typeof actor === 'string') {
    return actor === '' ? null : actor;
  }
  return actor.id === '' ? null : actor.id;
}

export function actorName(
  actor: EntitlementActorRef | null | undefined,
): string {
  if (actor === null || actor === undefined) {
    return '—';
  }
  if (typeof actor === 'string') {
    return actor === '' ? '—' : shortId(actor);
  }
  const name = actor.displayName?.trim() ?? '';
  return name === '' ? shortId(actor.id) : name;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** 纯日期 `YYYY-MM-DD` 原样展示；异常值不猜。 */
export function formatDate(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : '—';
}

/** 时间戳展示到分钟（后端 UTC ISO 8601，契约 §2.3）。 */
export function formatDateTime(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : '—';
}

/** 额度展示：千分位 + 固定 2 位小数；`null` 不隐式当成 0。 */
export function formatQuota(value: null | number | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value);
}

/** 列表行的权益快照摘要；缺摘要时明确提示「未返回」，不冒充 0 项。 */
export function snapshotSummaryText(
  summary: null | SnapshotSummary | undefined,
): string {
  if (!summary) {
    return '快照摘要未返回';
  }
  const quotaPart =
    summary.quotaTotal === null || summary.quotaTotal === undefined
      ? '无额度型功能键'
      : `额度合计 ${formatQuota(summary.quotaTotal)}`;
  return `功能键 ${summary.featureCount} 项 · 启用 ${summary.enabledCount} 项 · ${quotaPart}`;
}

/** 永久授权 ≠ 永久更新：维护期独立展示，不得由 `license_mode` 推导。 */
export function maintenanceNote(
  license: null | Pick<License, 'licenseMode' | 'maintenanceUntil'> | undefined,
): string {
  if (!license) {
    return '—';
  }
  const until = formatDate(license.maintenanceUntil);
  if (license.licenseMode === 'perpetual') {
    return until === '—'
      ? '永久授权：软件使用无到期日；维护期未登记，不代表包含永久更新'
      : `永久授权：软件使用无到期日；维护期至 ${until}，到期后不再包含版本更新与技术支持`;
  }
  return until === '—'
    ? '限期授权：维护期未登记'
    : `限期授权：维护期至 ${until}`;
}
