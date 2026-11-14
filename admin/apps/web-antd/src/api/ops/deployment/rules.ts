import type {
  DeploymentInstance,
  DeploymentInstanceStatus,
  DeploymentTransitionAction,
  VersionRecordResult,
} from './types';

/**
 * 部署域纯规则（可单测）：状态动作表、维护期判定、升级登记前置校验、原因校验。
 *
 * 为什么前端要再写一遍状态机：
 * 1. 服务端是唯一权威，非法迁移一律 409 `STATE_CONFLICT`；但页面必须**只渲染当前态
 *    允许的动作**，不能让运营点到一个必然失败的按钮。
 * 2. 界面**不得**直写状态：`active`/`maintenance` 之间的切换、`retired` 只能走
 *    `transition` 端点，`PATCH` 不回传 `status`（契约 §3.7 状态机 + §5.8）。
 * 3. 升级登记只登记**已执行的结果**，不触发任何远程升级；`fromVersion` 必须等于
 *    实例当前版本，否则服务端 409 `VERSION_MISMATCH`（契约 §6.4）。
 *
 * 不发明动作：动作名、所需权限码、允许的当前态全部来自契约 §3.7 / §5.8 / §6.4。
 */
import type { OpsPermission } from '#/constants/permissions';

import dayjs from 'dayjs';

import {
  isHighRiskPermission,
  OPS_PERMISSION,
  OPS_PERMISSION_LABEL,
} from '#/constants/permissions';

/** 拒绝原因码：稳定标识，便于单测断言与埋点，不依赖中文文案。 */
export type RuleDenyCode =
  | 'permission'
  | 'state'
  | 'validation'
  | 'version_mismatch';

export interface RuleDecision {
  allowed: boolean;
  code?: RuleDenyCode;
  /** 面向运营的说明，可直接展示。 */
  message?: string;
}

const ALLOW: RuleDecision = { allowed: true };

function deny(code: RuleDenyCode, message: string): RuleDecision {
  return { allowed: false, code, message };
}

// ------------------------------------------------------------------ 状态机

/**
 * 状态面板上的一个动作（契约 §3.7 状态机）。
 *
 * `highRisk` 由 `isHighRiskPermission('deployment.write')` 判定——当前契约的高风险清单
 * 不含 `deployment.write`，所以实例动作是「删除性但非高风险」；一旦后端把该动作码
 * 升为高风险，页面自动切换为高风险呈现（二次确认 + 影响摘要 + 必填原因），无需改页面。
 */
export interface DeploymentStateAction {
  /** 动作后果摘要，用于二次确认弹窗（页面不手写文案）。 */
  impact: string;
  label: string;
  /** 契约要求的权限码，恒为 `deployment.write`。 */
  permission: OpsPermission;
  /** 是否破坏性动作（退役），用于红色按钮与额外的确认勾选。 */
  destructive: boolean;
  highRisk: boolean;
  key: DeploymentTransitionAction;
  /** 契约要求必填原因的动作为 `retire`。 */
  requiresReason: boolean;
}

const DEPLOYMENT_ACTION_LABEL: Readonly<
  Record<DeploymentTransitionAction, string>
> = {
  end_maintenance: '结束维护期',
  go_live: '登记上线',
  retire: '退役实例',
  start_maintenance: '进入维护状态',
};

/**
 * 当前状态下允许的动作（契约 §3.7）。
 *
 * `retired` 是终态：没有任何动作，也不提供删除（历史事实不可抹除）。
 */
export function deploymentStatusActions(
  status: DeploymentInstanceStatus,
): DeploymentStateAction[] {
  const base = {
    permission: OPS_PERMISSION.DEPLOYMENT_WRITE,
    highRisk: isHighRiskPermission(OPS_PERMISSION.DEPLOYMENT_WRITE),
  } as const;
  switch (status) {
    case 'active': {
      return [
        {
          ...base,
          destructive: false,
          impact:
            '实例进入维护状态后仍为客户在用环境，仅表示正在维护；不影响合同与授权状态（契约 §3.7）。',
          key: 'start_maintenance',
          label: DEPLOYMENT_ACTION_LABEL.start_maintenance,
          requiresReason: false,
        },
        {
          ...base,
          destructive: true,
          impact:
            '退役为终态：实例不再出现在可用实例中，历史版本记录与工单仍可查。环境状态不会自动改变合同或授权状态，续用需另行处理授权。',
          key: 'retire',
          label: DEPLOYMENT_ACTION_LABEL.retire,
          requiresReason: true,
        },
      ];
    }
    case 'maintenance': {
      return [
        {
          ...base,
          destructive: false,
          impact: '结束维护后实例回到生效中；不改变任何授权或合同状态。',
          key: 'end_maintenance',
          label: DEPLOYMENT_ACTION_LABEL.end_maintenance,
          requiresReason: false,
        },
        {
          ...base,
          destructive: true,
          impact:
            '退役为终态：实例不再出现在可用实例中，历史版本记录与工单仍可查。',
          key: 'retire',
          label: DEPLOYMENT_ACTION_LABEL.retire,
          requiresReason: true,
        },
      ];
    }
    case 'planned': {
      return [
        {
          ...base,
          destructive: false,
          impact:
            '登记上线后实例进入生效中，可开始登记版本升级；本操作不执行任何远程安装（PRD §6.8）。',
          key: 'go_live',
          label: DEPLOYMENT_ACTION_LABEL.go_live,
          requiresReason: false,
        },
        {
          ...base,
          destructive: true,
          impact: '退役为终态：实例不再出现在可用实例中，历史记录保留。',
          key: 'retire',
          label: DEPLOYMENT_ACTION_LABEL.retire,
          requiresReason: true,
        },
      ];
    }
    default: {
      return [];
    }
  }
}

/**
 * 动作前置守卫（提交前拦截，服务端仍会再判一次）。
 *
 * 契约 §3.7 明确 `go_live` 需要 `go_live_on`：缺上线日期时服务端会拒绝，
 * 前端先给出可操作的说明，而不是让运营看到一条 409。
 */
export function guardDeploymentAction(
  action: DeploymentTransitionAction,
  instance: Pick<DeploymentInstance, 'goLiveOn' | 'status'>,
): RuleDecision {
  const allowed = deploymentStatusActions(instance.status).some(
    (item) => item.key === action,
  );
  if (!allowed) {
    return deny(
      'state',
      `当前状态「${instance.status}」不允许该动作，请刷新后按最新状态操作`,
    );
  }
  if (action === 'go_live' && (instance.goLiveOn ?? '').trim() === '') {
    return deny(
      'state',
      '登记上线前必须先在实例信息里补充上线日期（go_live_on），保存后再登记上线',
    );
  }
  return ALLOW;
}

// ------------------------------------------------------------------ 维护期

/** 维护期状态。`unknown` 表示「无法判定」，绝不猜成「正常」。 */
export type MaintenanceState = 'expired' | 'expiring' | 'healthy' | 'unknown';

export interface MaintenanceStatus {
  /** 剩余天数：已到期为负数，未登记/无法判定为 `null`。 */
  daysRemaining: null | number;
  state: MaintenanceState;
}

/**
 * 维护期将到期的预警窗口（天）。
 *
 * 契约未给窗口值，PRD §6.1 的到期窗口可由 `settings.overview.expiryWindowDays` 配置；
 * 本域按 30 天默认值实现并登记为推导项（journal 待确认）。窗口只影响**高亮**，
 * 不改变任何业务判定。
 */
export const MAINTENANCE_WARNING_DAYS = 30;

/**
 * 维护期状态判定（纯函数）。
 *
 * 关键约束（源码参考门 §5.4「超时/逾期一律读服务端字段」）：
 * 本函数**不读浏览器时钟**。`referenceDate` 必须由调用方传入服务端业务日期
 * （`GET /meta.serverTime` 按 `Asia/Shanghai` 折算，见 `businessDateOf()`）；
 * 拿不到服务端日期时返回 `unknown`，页面显示「无法判定」而不是凭本地时钟报警。
 */
export function maintenanceStatus(input: {
  maintenanceUntil?: null | string;
  referenceDate?: null | string;
  warningDays?: number;
}): MaintenanceStatus {
  const until = (input.maintenanceUntil ?? '').trim();
  const reference = (input.referenceDate ?? '').trim();
  if (until === '' || reference === '') {
    return { daysRemaining: null, state: 'unknown' };
  }
  const untilDate = dayjs(until);
  const referenceDate = dayjs(reference);
  if (!untilDate.isValid() || !referenceDate.isValid()) {
    return { daysRemaining: null, state: 'unknown' };
  }
  const daysRemaining = untilDate
    .startOf('day')
    .diff(referenceDate.startOf('day'), 'day');
  const warningDays = input.warningDays ?? MAINTENANCE_WARNING_DAYS;
  if (daysRemaining < 0) {
    return { daysRemaining, state: 'expired' };
  }
  if (daysRemaining <= warningDays) {
    return { daysRemaining, state: 'expiring' };
  }
  return { daysRemaining, state: 'healthy' };
}

/**
 * 服务端时刻 → 业务时区日期（`YYYY-MM-DD`）。
 *
 * 用 `Intl` 而不是本地时钟：契约 §2.3 规定「今天」按运营端业务时区
 * `Asia/Shanghai` 计算，直接取浏览器本地日期会在 00:00–08:00 差一天。
 */
export function businessDateOf(
  instant: string,
  timeZone = 'Asia/Shanghai',
): null | string {
  const parsed = dayjs(instant);
  if (!parsed.isValid()) {
    return null;
  }
  const formatted = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(parsed.toDate());
  return /^\d{4}-\d{2}-\d{2}$/.test(formatted) ? formatted : null;
}

// ------------------------------------------------------------------ 升级登记

/**
 * 升级登记前置校验（契约 §5.8 请求体 + §6.4 `VERSION_MISMATCH`）。
 *
 * 版本号是不透明字符串：只做「非空」「与当前版本严格相等」「前后不同」三项判断，
 * 不做大小比较——`v1.10.0` 与 `v1.9.0` 谁新由人工判断，前端不猜。
 */
export function validateVersionRecordInput(input: {
  currentVersion?: null | string;
  executedOn: string;
  fromVersion: string;
  toVersion: string;
}): RuleDecision {
  const from = input.fromVersion.trim();
  const to = input.toVersion.trim();
  if (from === '') {
    return deny('validation', '请填写升级前版本');
  }
  if (to === '') {
    return deny('validation', '请填写升级后版本');
  }
  if (to === from) {
    return deny('state', '升级后版本不能与升级前版本相同');
  }
  if (input.executedOn.trim() === '') {
    return deny('validation', '请填写执行日期');
  }
  const current = (input.currentVersion ?? '').trim();
  if (current !== '' && from !== current) {
    return deny(
      'version_mismatch',
      `升级前版本必须等于实例当前版本（${current}）。实例可能刚被他人登记过升级，请刷新后重试`,
    );
  }
  return ALLOW;
}

/** 结果选项（契约 §3.7 `result`）。`rolled_back` 也在升级记录里留痕。 */
export const VERSION_RESULT_OPTIONS: {
  description: string;
  label: string;
  value: VersionRecordResult;
}[] = [
  {
    description: '升级完成并已在客户环境生效',
    label: '成功',
    value: 'succeeded',
  },
  {
    description: '升级失败，实例版本保持不变',
    label: '失败',
    value: 'failed',
  },
  {
    description: '升级后已回滚，实例仍停留在升级前版本',
    label: '已回滚',
    value: 'rolled_back',
  },
];

// ------------------------------------------------------------------ 原因与权限

export const REASON_MAX_LENGTH = 500;

export interface ReasonValidation {
  message?: string;
  ok: boolean;
  value: string;
}

/** 原因必填校验（`retire` 与所有 `deployment.write` 高风险化后的动作）。 */
export function validateDeploymentReason(raw: string): ReasonValidation {
  const value = raw.trim();
  if (value === '') {
    return {
      message: '请填写操作原因（会写入审计，便于事后追溯）',
      ok: false,
      value,
    };
  }
  if (value.length > REASON_MAX_LENGTH) {
    return {
      message: `原因不能超过 ${REASON_MAX_LENGTH} 字`,
      ok: false,
      value,
    };
  }
  return { ok: true, value };
}

/** 是否有权查看实例与升级历史（`deployment.read`）。 */
export function canReadDeployment(grantedCodes: readonly string[]): boolean {
  return grantedCodes.includes(OPS_PERMISSION.DEPLOYMENT_READ);
}

/** 是否有权维护实例、登记升级、推进环境状态（`deployment.write`）。 */
export function canWriteDeployment(grantedCodes: readonly string[]): boolean {
  return grantedCodes.includes(OPS_PERMISSION.DEPLOYMENT_WRITE);
}

/** 动作所需权限码的中文说明（复用权限目录的唯一真源）。 */
export function permissionLabel(permission: OpsPermission): string {
  return OPS_PERMISSION_LABEL[permission] ?? permission;
}

// ------------------------------------------------------------------ 固定文案

/**
 * 版本历史只追加的界面说明（所有版本视图共用，避免各页文案不一致）。
 * 契约 §3.7：`ops.deployment_version_records` **仅 INSERT**，无 UPDATE/DELETE 授权。
 */
export const VERSION_HISTORY_IMMUTABLE_NOTE =
  '版本升级记录仅追加、不可修改或删除：登记即成为历史事实，写错只能再登记一条更正记录。';

/**
 * 「永久授权 ≠ 永久更新」的完整说明（PRD §6.6 明文要求）。
 *
 * 单点真源：列表、详情、维护期提示都从这里取文案，避免三处口径不一致。
 * 语义要点：`license_mode='perpetual'` 只说明软件**使用**无到期日；
 * 版本更新与技术支持以**维护期**为准，两者不得互相推导。
 */
export const PERPETUAL_NOT_PERPETUAL_UPDATE_NOTE =
  '永久授权 ≠ 永久更新：永久授权只表示软件使用无到期日，不代表持续包含版本升级与技术支持。能否继续升级以维护期（maintenance_until）是否在服务期内为准。';
