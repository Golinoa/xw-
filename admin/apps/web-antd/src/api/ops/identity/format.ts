/**
 * identity-audit 域展示映射：成员状态、导出状态与类型、审计动作、行为主体、时间。
 *
 * 原则（契约 §2.6）：未知枚举值降级为「未知(原值)」，不渲染空白，也不猜中文名。
 * 审计动作是**开放词表**（后端各域都会写 `action`），因此这里只覆盖已知动作，
 * 未知动作原样显示，避免前端硬编码出一份与后端不同步的「动作中文表」。
 */
import type { OpsOperatorStatus } from './session';
import type { OpsActorLike, OpsExportStatus, OpsExportType } from './types';

import dayjs from 'dayjs';

/** Tag 颜色（ant-design-vue 语义色）。 */
export type OpsTagColor = 'blue' | 'default' | 'green' | 'orange' | 'red';

export interface EnumView {
  color: OpsTagColor;
  /** 是否为已登记枚举；未知值用于在界面上同时提示契约漂移。 */
  known: boolean;
  label: string;
}

const UNKNOWN_PREFIX = '未知';

const OPERATOR_STATUS_LABEL: Readonly<Record<OpsOperatorStatus, string>> = {
  active: '启用',
  disabled: '已停用',
  invited: '待接受邀请',
};

const OPERATOR_STATUS_COLOR: Readonly<Record<OpsOperatorStatus, OpsTagColor>> =
  {
    active: 'green',
    disabled: 'red',
    invited: 'blue',
  };

export function operatorStatusView(status: string): EnumView {
  const label = OPERATOR_STATUS_LABEL[status as OpsOperatorStatus];
  if (label === undefined) {
    return {
      color: 'default',
      known: false,
      label: `${UNKNOWN_PREFIX}(${status})`,
    };
  }
  return {
    color: OPERATOR_STATUS_COLOR[status as OpsOperatorStatus],
    known: true,
    label,
  };
}

const EXPORT_STATUS_LABEL: Readonly<Record<OpsExportStatus, string>> = {
  expired: '已过期',
  failed: '失败',
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
};

const EXPORT_STATUS_COLOR: Readonly<Record<OpsExportStatus, OpsTagColor>> = {
  expired: 'default',
  failed: 'red',
  queued: 'blue',
  running: 'orange',
  succeeded: 'green',
};

export function exportStatusView(status: string): EnumView {
  const label = EXPORT_STATUS_LABEL[status as OpsExportStatus];
  if (label === undefined) {
    return {
      color: 'default',
      known: false,
      label: `${UNKNOWN_PREFIX}(${status})`,
    };
  }
  return {
    color: EXPORT_STATUS_COLOR[status as OpsExportStatus],
    known: true,
    label,
  };
}

const EXPORT_TYPE_LABEL: Readonly<Record<OpsExportType, string>> = {
  contracts: '合同',
  customers: '客户',
  receipts: '收款',
  receivables: '应收',
  tickets: '工单',
};

export function exportTypeView(type: string): EnumView {
  const label = EXPORT_TYPE_LABEL[type as OpsExportType];
  if (label === undefined) {
    return {
      color: 'default',
      known: false,
      label: `${UNKNOWN_PREFIX}(${type})`,
    };
  }
  return { color: 'blue', known: true, label };
}

/** 导出类型下拉选项（顺序按契约 §5.9 枚举顺序）。 */
export const EXPORT_TYPE_OPTIONS = (
  Object.keys(EXPORT_TYPE_LABEL) as OpsExportType[]
).map((value) => ({ label: EXPORT_TYPE_LABEL[value], value }));

export const EXPORT_STATUS_OPTIONS = (
  Object.keys(EXPORT_STATUS_LABEL) as OpsExportStatus[]
).map((value) => ({ label: EXPORT_STATUS_LABEL[value], value }));

/** 审计动作的已知中文名。未知动作原样展示——后端新增动作不该让页面显示空白。 */
const AUDIT_ACTION_LABEL: Readonly<Record<string, string>> = {
  'dictionary_item.create': '新增字典项',
  'dictionary_item.update': '修改字典项',
  'export.create': '发起数据导出',
  'operator.invite': '邀请运营成员',
  'operator.roles_changed': '变更成员角色',
  'operator.status_changed': '变更成员状态',
  'operator.update': '修改运营成员',
  'role.create': '创建角色',
  'role.permissions_changed': '变更角色权限',
  'role.update': '修改角色',
  'settings.update': '修改系统设置',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? action;
}

/** 是否已登记的动作（用于在界面上标记「未登记动作」而不阻断展示）。 */
export function isKnownAuditAction(action: string): boolean {
  return action in AUDIT_ACTION_LABEL;
}

/**
 * 行为主体展示。
 *
 * `requestedBy` / `updatedBy` 在契约里只给了字段名（表列是 uuid），因此两种形态都接受：
 * 字符串按 id 显示，对象取 `displayName ?? id`。缺失时显示占位符而不是空串。
 */
export function actorLabel(actor: null | OpsActorLike | undefined): string {
  if (!actor) {
    return '—';
  }
  if (typeof actor === 'string') {
    return actor;
  }
  return actor.displayName || actor.id;
}

/** 时间展示：`YYYY-MM-DD HH:mm`（运营端业务时区按浏览器本地时区渲染，仅展示用）。 */
export function formatDateTime(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : '—';
}

/** 数字展示：非有限数显示占位符，不隐式当 0（与金额口径一致）。 */
export function formatCount(value: null | number | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return new Intl.NumberFormat('zh-CN').format(value);
}
