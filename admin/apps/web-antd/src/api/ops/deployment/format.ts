/**
 * 部署域展示映射：实例状态、部署类型、升级结果、维护期文案与日期格式化。
 *
 * 原则（契约 §2.6）：未知枚举值必须降级为「未知(原值)」，不能渲染空白——
 * 后端加法式新增状态时页面不应出现「没有状态」的脏数据观感。
 *
 * 维护期是本域最容易误读的字段：**永久授权 ≠ 永久更新**（PRD §6.6）。
 * 所有维护期文案都集中在 `maintenanceStateView()` / `deploymentMaintenanceNotice()`，
 * 页面不得自行拼接，避免同一事实出现两种口径。
 */
import type { MaintenanceState, MaintenanceStatus } from './rules';
import type {
  DeploymentInstanceStatus,
  DeploymentType,
  VersionRecordResult,
} from './types';

import dayjs from 'dayjs';

import {
  MAINTENANCE_WARNING_DAYS,
  maintenanceStatus,
  PERPETUAL_NOT_PERPETUAL_UPDATE_NOTE,
} from './rules';

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

const INSTANCE_STATUS_LABEL: Readonly<
  Record<DeploymentInstanceStatus, string>
> = {
  active: '生效中',
  maintenance: '维护中',
  planned: '待上线',
  retired: '已退役',
};

const INSTANCE_STATUS_COLOR: Readonly<
  Record<DeploymentInstanceStatus, OpsTagColor>
> = {
  active: 'green',
  maintenance: 'orange',
  planned: 'blue',
  retired: 'default',
};

const DEPLOYMENT_TYPE_LABEL: Readonly<Record<DeploymentType, string>> = {
  dedicated: '托管独享',
  private: '客户私有环境',
};

const VERSION_RESULT_LABEL: Readonly<Record<VersionRecordResult, string>> = {
  failed: '失败',
  rolled_back: '已回滚',
  succeeded: '成功',
};

const VERSION_RESULT_COLOR: Readonly<Record<VersionRecordResult, OpsTagColor>> =
  {
    failed: 'red',
    rolled_back: 'orange',
    succeeded: 'green',
  };

/** 授权方式展示（取值为授权域 `license_mode`，本域只做只读展示）。 */
const LICENSE_MODE_LABEL: Readonly<Record<string, string>> = {
  perpetual: '永久授权',
  term: '限期授权',
};

export function licenseModeLabel(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  return LICENSE_MODE_LABEL[value] ?? `${UNKNOWN_PREFIX}(${value})`;
}

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

export function instanceStatusView(status: string): StatusView {
  return withUnknown(status, INSTANCE_STATUS_LABEL, INSTANCE_STATUS_COLOR);
}

export function deploymentTypeLabel(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  return (
    DEPLOYMENT_TYPE_LABEL[value as DeploymentType] ??
    `${UNKNOWN_PREFIX}(${value})`
  );
}

export function versionResultView(result: string): StatusView {
  return withUnknown(result, VERSION_RESULT_LABEL, VERSION_RESULT_COLOR);
}

export const INSTANCE_STATUS_OPTIONS = (
  ['planned', 'active', 'maintenance', 'retired'] as const
).map((value) => ({ label: INSTANCE_STATUS_LABEL[value], value }));

export const DEPLOYMENT_TYPE_OPTIONS = (['private', 'dedicated'] as const).map(
  (value) => ({ label: DEPLOYMENT_TYPE_LABEL[value], value }),
);

export const VERSION_RESULT_VIEW_OPTIONS = (
  ['succeeded', 'failed', 'rolled_back'] as const
).map((value) => ({ label: VERSION_RESULT_LABEL[value], value }));

/**
 * 操作者归一化：契约表格列是 `uuid`，展示需要姓名。
 * 取不到姓名时退回 id 前 8 位，绝不渲染空字符串。
 */
export function actorName(
  actor: null | string | undefined | { displayName?: string; id: string },
): string {
  if (actor === null || actor === undefined) {
    return '—';
  }
  if (typeof actor === 'string') {
    return actor === '' ? '—' : shortId(actor);
  }
  const name = (actor.displayName ?? '').trim();
  return name === '' ? shortId(actor.id) : name;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** 纯日期 `YYYY-MM-DD` 原样展示；异常值不猜（契约 §2.3）。 */
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

/** 版本号是不透明字符串：空值显示「未登记」，不做任何规范化。 */
export function versionText(value: null | string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? '未登记' : trimmed;
}

/** 版本迁移展示：`v1.2.2 → v1.2.3`。 */
export function versionTransitionText(
  fromVersion: null | string | undefined,
  toVersion: null | string | undefined,
): string {
  return `${versionText(fromVersion)} → ${versionText(toVersion)}`;
}

export interface MaintenanceStateView extends StatusView {
  /** 毫秒无关的剩余天数；`unknown` 时为 `null`。 */
  daysRemaining: null | number;
  state: MaintenanceState;
  /** 一句话结论，直接放在列表列与详情横幅里。 */
  summary: string;
}

const MAINTENANCE_STATE_COLOR: Readonly<Record<MaintenanceState, OpsTagColor>> =
  {
    expired: 'red',
    expiring: 'orange',
    healthy: 'green',
    unknown: 'default',
  };

/**
 * 维护期状态视图（唯一真源）。
 *
 * `referenceDate` 必须是**服务端**业务日期（见 `rules.businessDateOf`）；
 * 传空则一律 `unknown`，页面显示「无法判定」，不凭本地时钟报警。
 */
export function maintenanceStateView(input: {
  maintenanceUntil?: null | string;
  referenceDate?: null | string;
  warningDays?: number;
}): MaintenanceStateView {
  const status: MaintenanceStatus = maintenanceStatus(input);
  const until = formatDate(input.maintenanceUntil);
  const warningDays = input.warningDays ?? MAINTENANCE_WARNING_DAYS;
  switch (status.state) {
    case 'expired': {
      return {
        color: MAINTENANCE_STATE_COLOR.expired,
        daysRemaining: status.daysRemaining,
        known: true,
        label: '维护期已到期',
        state: 'expired',
        summary: `维护期已于 ${until} 到期（逾期 ${Math.abs(
          status.daysRemaining ?? 0,
        )} 天）：不再包含版本升级与技术支持，继续升级需先续费维护期`,
      };
    }
    case 'expiring': {
      return {
        color: MAINTENANCE_STATE_COLOR.expiring,
        daysRemaining: status.daysRemaining,
        known: true,
        label: '维护期将到期',
        state: 'expiring',
        summary: `维护期至 ${until}，还剩 ${
          status.daysRemaining ?? 0
        } 天（窗口 ${warningDays} 天）：到期后不再包含版本升级与技术支持`,
      };
    }
    case 'healthy': {
      return {
        color: MAINTENANCE_STATE_COLOR.healthy,
        daysRemaining: status.daysRemaining,
        known: true,
        label: '维护期内',
        state: 'healthy',
        summary: `维护期至 ${until}，还剩 ${status.daysRemaining ?? 0} 天`,
      };
    }
    default: {
      return {
        color: MAINTENANCE_STATE_COLOR.unknown,
        daysRemaining: null,
        known: false,
        label: '维护期未登记',
        state: 'unknown',
        summary:
          '维护期未登记或无法判定（未取到服务端业务日期）：请补齐 maintenance_until，不要假定「永久授权」等于永久更新',
      };
    }
  }
}

/**
 * 「永久授权 ≠ 永久更新」的落点（PRD §6.6）。
 *
 * 只有在实例确实关联了永久授权时才追加永久授权说明；**任何**情况下都不允许
 * 从「永久授权」推导出「可永久升级」——维护期状态仍然是唯一的升级依据。
 */
export function deploymentMaintenanceNotice(input: {
  maintenanceUntil?: null | string;
  perpetualLicenseNos?: readonly string[];
  referenceDate?: null | string;
}): { permanentNote: null | string; view: MaintenanceStateView } {
  const view = maintenanceStateView({
    maintenanceUntil: input.maintenanceUntil,
    referenceDate: input.referenceDate,
  });
  const perpetual = (input.perpetualLicenseNos ?? []).filter(
    (item) => item.trim() !== '',
  );
  if (perpetual.length === 0) {
    return { permanentNote: null, view };
  }
  const licenseText = `该实例关联永久授权（${perpetual.join('、')}）`;
  return {
    permanentNote: `${licenseText}。${PERPETUAL_NOT_PERPETUAL_UPDATE_NOTE}`,
    view,
  };
}
