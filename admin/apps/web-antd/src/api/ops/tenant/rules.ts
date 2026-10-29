import type {
  CreateTenantCommandInput,
  TenantCommandStatus,
  TenantCommandType,
  TenantErrorCategory,
  TenantMappingStatus,
} from './types';

/**
 * 租户交付域规则（前端呈现与提交前拦截）。
 *
 * 服务端是唯一权威，但交付页面必须在**点击之前**把「为什么不能做」讲清楚：
 * 永久性错误不能重试、已发生尝试的命令不能取消、缺 `sync_version` 不能下发、
 * 非 `pending` 映射不能改外部租户 ID。每条判定都有单测覆盖，文案与
 * `details.reason`（契约 §6.4）保持一致。
 */
import type { OpsPermission } from '#/constants/permissions';

import { isHighRiskPermission, OPS_PERMISSION } from '#/constants/permissions';

/** 拒绝原因码：稳定标识，单测断言不依赖中文文案。 */
export type TenantRuleDenyCode =
  | 'attempted'
  | 'not_pending'
  | 'not_retryable'
  | 'permanent_error'
  | 'permission'
  | 'reason_required'
  | 'state'
  | 'version_missing';

export interface RuleDecision {
  allowed: boolean;
  code?: TenantRuleDenyCode;
  /** 面向运营的说明，可直接展示。 */
  message?: string;
}

const ALLOW: RuleDecision = { allowed: true };

function deny(code: TenantRuleDenyCode, message: string): RuleDecision {
  return { allowed: false, code, message };
}

export const REASON_MAX_LENGTH = 500;

export interface ReasonValidation {
  message?: string;
  ok: boolean;
  value: string;
}

/** 原因必填（所有命令、重试、取消都写审计，契约 §3.6）。 */
export function validateReason(raw: string): ReasonValidation {
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
  return { message: undefined, ok: true, value };
}

/**
 * 命令类型 → 动作码（契约 §3.6 状态机表 & §5.7）。
 * 交给 `isHighRiskPermission()` 派生高风险判定，页面不手写动作码字符串。
 */
const COMMAND_PERMISSION: Readonly<Record<TenantCommandType, OpsPermission>> = {
  activate: OPS_PERMISSION.TENANT_PROVISION,
  bind: OPS_PERMISSION.TENANT_PROVISION,
  extend: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
  provision: OPS_PERMISSION.TENANT_PROVISION,
  resume: OPS_PERMISSION.TENANT_RESTORE,
  revoke: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
  suspend: OPS_PERMISSION.TENANT_SUSPEND,
  sync_entitlement: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
};

export function commandPermission(type: TenantCommandType): OpsPermission {
  return COMMAND_PERMISSION[type];
}

/**
 * 该命令是否需要高风险二次确认 + 原因必填（契约 §4 高风险动作清单）。
 *
 * 契约 §4 把 `tenant.provision` / `tenant.suspend` / `tenant.restore` /
 * `tenant.retry` / `entitlement.execute` 全部列为高风险，因此本域命令
 * 实际上都需要二次确认；未来若降级某个动作码，这里会自动跟随，不用改页面。
 */
export function commandRequiresHighRisk(type: TenantCommandType): boolean {
  return isHighRiskPermission(commandPermission(type));
}

export function canCreateCommand(context: {
  hasPermission: boolean;
  type: TenantCommandType;
}): RuleDecision {
  if (!context.hasPermission) {
    return deny(
      'permission',
      `缺少「${commandPermission(context.type)}」权限，不能下发该命令`,
    );
  }
  return ALLOW;
}

export interface CommandDraft {
  changeRequestId?: string;
  commandType: TenantCommandType;
  contractId?: string;
}

/** 命令组装结果：失败时**不产生请求体**，避免页面用 0 兜底版本号。 */
export type ComposeCommandResult =
  | { code: TenantRuleDenyCode; message: string; ok: false }
  | { ok: true; value: CreateTenantCommandInput };

/**
 * 组装下发给后端的命令体。
 *
 * `expectedSyncVersion` 必须直接来自映射详情（`mapping.syncVersion`）：
 * 缺失、非整数、负数一律拒绝——契约 `CHECK(expected_sync_version >= 0)` 与
 * 状态机守卫「必须等于 `mapping.sync_version`」都不允许 `0` 兜底，
 * 否则会把「版本未知」伪装成「期望版本 0」，必然触发 409 或错误覆盖。
 */
export function composeCommandInput(context: {
  draft: CommandDraft;
  expectedSyncVersion: null | number | undefined;
  reason: string;
}): ComposeCommandResult {
  const version = context.expectedSyncVersion;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0
  ) {
    return {
      code: 'version_missing',
      message:
        '缺少映射的当前同步版本（sync_version），已阻止下发。请刷新映射详情后重试。',
      ok: false,
    };
  }
  const validated = validateReason(context.reason);
  if (!validated.ok) {
    return {
      code: 'reason_required',
      message: validated.message ?? '请填写操作原因',
      ok: false,
    };
  }
  const contractId = context.draft.contractId?.trim() ?? '';
  const changeRequestId = context.draft.changeRequestId?.trim() ?? '';
  return {
    ok: true,
    value: {
      commandType: context.draft.commandType,
      expectedSyncVersion: version,
      reason: validated.value,
      ...(contractId === '' ? {} : { contractId }),
      ...(changeRequestId === '' ? {} : { changeRequestId }),
    },
  };
}

export interface RetryDecisionContext {
  hasPermission: boolean;
  lastErrorCategory?: null | TenantErrorCategory;
  /** 服务端在命令详情里给出的可重试判定。 */
  serverRetryable?: boolean;
  status: TenantCommandStatus;
}

/**
 * 重试可用性判定（契约 §3.6：`failed --retry--> retrying`）。
 *
 * 判定顺序固定为「权限 → 永久错误 → 状态 → 服务端判定」：
 * 永久错误必须先说清「重试也没用」，否则运营会反复点击。
 */
export function canRetryCommand(context: RetryDecisionContext): RuleDecision {
  if (!context.hasPermission) {
    return deny(
      'permission',
      `缺少「重试失败命令」权限（${OPS_PERMISSION.TENANT_RETRY}），不能重试`,
    );
  }
  if (context.lastErrorCategory === 'permanent') {
    return deny(
      'permanent_error',
      '永久性错误不可重试：业务规则已拒绝该命令，重试不会改变结果，请修正数据后重新发起',
    );
  }
  if (context.status !== 'failed') {
    return deny(
      'state',
      `只有「失败」状态的命令才能重试，当前状态为「${context.status}」`,
    );
  }
  if (context.serverRetryable === false) {
    return deny(
      'not_retryable',
      '服务端判定该命令当前不可重试，请查看错误详情',
    );
  }
  return ALLOW;
}

export interface CancelDecisionContext {
  hasPermission: boolean;
  status: TenantCommandStatus;
  /** 该命令已经发生的尝试次数（契约：仅零次尝试可取消）。 */
  attemptCount: number;
}

/** 取消可用性判定（契约 §3.6：`pending --cancel--> cancelled`，仅未发生任何尝试）。 */
export function canCancelCommand(context: CancelDecisionContext): RuleDecision {
  if (!context.hasPermission) {
    return deny('permission', '缺少该命令对应的下发权限，不能取消');
  }
  // 先讲「已尝试」：这是运营最需要知道的信息（结果可能已在远端发生）。
  if (context.attemptCount > 0) {
    return deny(
      'attempted',
      `该命令已发生 ${context.attemptCount} 次执行尝试，不能取消（仅零次尝试的命令可取消）；结果未知时请先查询命令状态`,
    );
  }
  if (context.status !== 'pending') {
    return deny(
      'not_pending',
      `只有「待执行」状态的命令才能取消，当前状态为「${context.status}」`,
    );
  }
  return ALLOW;
}

/** 是否允许改映射的外部租户 ID（契约 §5.7：非 `pending` 禁止改外部 ID）。 */
export function canEditMappingExternalId(context: {
  hasPermission: boolean;
  status: TenantMappingStatus;
}): RuleDecision {
  if (!context.hasPermission) {
    return deny('permission', '缺少 tenant.provision 权限，不能修改映射');
  }
  if (context.status !== 'pending') {
    return deny(
      'state',
      '映射已开通或已终止，外部租户 ID 不可再改（避免与 udone 侧数据错位）',
    );
  }
  return ALLOW;
}
