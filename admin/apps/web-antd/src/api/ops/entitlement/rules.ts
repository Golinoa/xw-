import type {
  ChangeRequestStatus,
  ChangeRequestType,
  EntitlementChangeRequest,
  EntitlementStatus,
} from './types';

/**
 * 权益域状态机与动作守卫（前端呈现 + 提交前拦截）。
 *
 * 为什么前端要再写一遍状态机：
 * 1. 服务端是唯一权威，非法迁移一律 409 `STATE_CONFLICT`；但页面必须**只渲染当前态
 *    允许的动作**，不能让运营点到一个必然失败的按钮。
 * 2. `approved_by <> requested_by`（契约 §3.5 CHECK）与「未审批即执行」
 *    （409 `STATE_CONFLICT` + `details.reason='APPROVAL_REQUIRED'`）必须在点击前讲清楚。
 * 3. 界面**不得**直写终态：`active/suspended` 上的暂停、撤销、到期只能发起变更申请，
 *    由「审批 → 执行」推进（源码参考门 §3.2 约束）。
 *
 * 本文件不发明动作：动作名、所需权限码、允许的当前态全部来自契约 §3.5 / §5.6。
 */
import type { OpsPermission } from '#/constants/permissions';

import {
  isHighRiskPermission,
  OPS_PERMISSION,
  OPS_PERMISSION_LABEL,
} from '#/constants/permissions';

import { actorId } from './format';

/** 拒绝原因码：稳定标识，便于单测断言与埋点，不依赖中文文案。 */
export type RuleDenyCode =
  | 'approval_required'
  | 'identity_unknown'
  | 'permission'
  | 'segregation_of_duty'
  | 'state';

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

/** 变更申请可发起的类型（生效后）；`issue` 只在首次发放时使用。 */
const POST_ACTIVE_CHANGE_TYPES: readonly ChangeRequestType[] = [
  'extend',
  'upgrade',
  'downgrade',
  'quota_change',
  'suspend',
  'resume',
  'expire',
  'revoke',
];

/** 只在对应状态下有意义（避免「暂停中再暂停」「生效中恢复」这类无效申请）。 */
const STATUS_EXCLUDED_CHANGE_TYPES: Readonly<
  Record<'active' | 'suspended', ChangeRequestType[]>
> = {
  active: ['resume'],
  suspended: ['suspend'],
};

/**
 * 状态面板上的一个动作。
 *
 * `key` 以 `change:` 前缀表示「创建变更申请」，其余为订阅/授权自身的草稿期迁移。
 */
export interface StateAction {
  /** 变更申请类型；仅 `change:` 动作为非空。 */
  changeType?: ChangeRequestType;
  highRisk: boolean;
  key: string;
  label: string;
  permission: OpsPermission;
  /** 契约 §5.6 的过渡端点要求 `reason` 必填。 */
  requiresReason: boolean;
}

const CHANGE_ACTION_LABEL: Readonly<Record<ChangeRequestType, string>> = {
  downgrade: '申请降级（缩权）',
  expire: '申请到期',
  extend: '申请延期',
  issue: '申请新发',
  quota_change: '申请额度变更',
  resume: '申请恢复',
  revoke: '申请撤销授权',
  suspend: '申请暂停',
  upgrade: '申请升级',
};

/**
 * 当前状态下允许的动作（契约 §3.5 订阅/授权状态机）。
 *
 * 终态（`expired`/`revoked`）没有任何动作——只能新建记录，历史快照保持只读。
 */
export function entitlementStatusActions(
  status: EntitlementStatus,
): StateAction[] {
  switch (status) {
    case 'active':
    case 'suspended': {
      const excluded = STATUS_EXCLUDED_CHANGE_TYPES[status];
      const changeTypes = POST_ACTIVE_CHANGE_TYPES.filter(
        (type) => !excluded.includes(type),
      );
      return changeTypes.map((type) => ({
        changeType: type,
        highRisk: isHighRiskEntitlementAction({
          changeType: type,
          permission: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
        }),
        key: `change:${type}`,
        label: CHANGE_ACTION_LABEL[type],
        permission: OPS_PERMISSION.ENTITLEMENT_REQUEST,
        requiresReason: true,
      }));
    }
    case 'draft': {
      return [
        {
          highRisk: false,
          key: 'submit',
          label: '提交审批',
          permission: OPS_PERMISSION.ENTITLEMENT_REQUEST,
          requiresReason: false,
        },
      ];
    }
    case 'pending_approval': {
      return [
        {
          highRisk: true,
          key: 'approve',
          label: '审批通过（生效）',
          permission: OPS_PERMISSION.ENTITLEMENT_APPROVE,
          requiresReason: true,
        },
        {
          highRisk: true,
          key: 'reject',
          label: '驳回（退回草稿）',
          permission: OPS_PERMISSION.ENTITLEMENT_APPROVE,
          requiresReason: true,
        },
      ];
    }
    default: {
      return [];
    }
  }
}

/** 变更申请可执行的动作（契约 §3.5「变更申请状态机（推导）」，登记 U-04）。 */
export interface ChangeRequestAction {
  /** 取消允许 `entitlement.request` **或** `entitlement.approve`（契约 §3.5）。 */
  altPermission?: OpsPermission;
  highRisk: boolean;
  key: string;
  label: string;
  permission: OpsPermission;
  requiresReason: boolean;
}

export function changeRequestActions(
  status: ChangeRequestStatus,
  changeType?: ChangeRequestType,
): ChangeRequestAction[] {
  switch (status) {
    case 'approved': {
      return [
        {
          highRisk: isHighRiskEntitlementAction({
            changeType,
            permission: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
          }),
          key: 'execute',
          label: '执行并下发同步',
          permission: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
          requiresReason: true,
        },
        {
          altPermission: OPS_PERMISSION.ENTITLEMENT_APPROVE,
          highRisk: false,
          key: 'cancel',
          label: '取消申请',
          permission: OPS_PERMISSION.ENTITLEMENT_REQUEST,
          requiresReason: true,
        },
      ];
    }
    case 'draft': {
      return [
        {
          highRisk: false,
          key: 'submit',
          label: '提交审批',
          permission: OPS_PERMISSION.ENTITLEMENT_REQUEST,
          requiresReason: true,
        },
      ];
    }
    case 'failed': {
      return [
        {
          highRisk: true,
          key: 'retry',
          label: '重试执行',
          permission: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
          requiresReason: true,
        },
      ];
    }
    case 'pending_approval': {
      return [
        {
          highRisk: true,
          key: 'approve',
          label: '审批通过',
          permission: OPS_PERMISSION.ENTITLEMENT_APPROVE,
          requiresReason: true,
        },
        {
          highRisk: true,
          key: 'reject',
          label: '驳回',
          permission: OPS_PERMISSION.ENTITLEMENT_APPROVE,
          requiresReason: true,
        },
        {
          altPermission: OPS_PERMISSION.ENTITLEMENT_APPROVE,
          highRisk: false,
          key: 'cancel',
          label: '取消申请',
          permission: OPS_PERMISSION.ENTITLEMENT_REQUEST,
          requiresReason: true,
        },
      ];
    }
    default: {
      return [];
    }
  }
}

/** 动作所需权限码的中文说明（复用权限目录的唯一真源）。 */
export function permissionLabel(permission: OpsPermission): string {
  return OPS_PERMISSION_LABEL[permission] ?? permission;
}

/**
 * 高风险动作判定。
 *
 * 基线是 `isHighRiskPermission()`（`entitlement.approve` / `entitlement.execute`
 * 都在高风险清单里），但 `execute` 只在**缩权/暂停**（`revoke`/`suspend`）时
 * 需要二次确认——按 Task 6 负责人规则收敛，避免把每次延期都变成高风险弹窗。
 */
export function isHighRiskEntitlementAction(input: {
  changeType?: ChangeRequestType | null;
  permission: OpsPermission;
}): boolean {
  if (!isHighRiskPermission(input.permission)) {
    return false;
  }
  if (input.permission === OPS_PERMISSION.ENTITLEMENT_EXECUTE) {
    return input.changeType === 'revoke' || input.changeType === 'suspend';
  }
  return true;
}

export interface ChangeRequestGuardContext {
  changeRequest: Pick<
    EntitlementChangeRequest,
    'changeType' | 'requestedBy' | 'status'
  >;
  currentOperatorId: null | string | undefined;
  hasApprovePermission: boolean;
  hasExecutePermission: boolean;
  hasRequestPermission?: boolean;
}

/**
 * 审批/驳回可用性。
 *
 * 判定顺序刻意固定为「权限 → 身份 → 状态 → 职责分离」：没有权限的人不需要知道
 * 「自己是申请人」，避免暴露与授权无关的信息。申请人自批时按钮禁用并说明原因
 * （服务端同样返回 403 `FORBIDDEN` + `details.reason='SEGREGATION_OF_DUTY'`）。
 */
export function canApproveChangeRequest(
  context: ChangeRequestGuardContext,
): RuleDecision {
  if (!context.hasApprovePermission) {
    return deny(
      'permission',
      '缺少「审核权益变更申请」权限（entitlement.approve），无法审批',
    );
  }
  const current = context.currentOperatorId ?? '';
  if (current === '') {
    return deny('identity_unknown', '无法确认当前操作人身份，请重新登录后再试');
  }
  if (context.changeRequest.status !== 'pending_approval') {
    return deny('state', '只有「待审批」的变更申请可以审批或驳回');
  }
  if (actorId(context.changeRequest.requestedBy) === current) {
    return deny(
      'segregation_of_duty',
      '你是该变更申请的提交人，审批人必须是另一个人（契约 CHECK approved_by <> requested_by），请转交其他有审批权限的同事',
    );
  }
  return ALLOW;
}

/** 驳回同样受职责分离约束：申请人不能自己驳回自己的申请。 */
export function canRejectChangeRequest(
  context: ChangeRequestGuardContext,
): RuleDecision {
  return canApproveChangeRequest(context);
}

/**
 * 执行可用性：**未审批即执行**必须被前端拦住（服务端会返回 409 + `APPROVAL_REQUIRED`）。
 */
export function canExecuteChangeRequest(context: {
  changeRequest: Pick<EntitlementChangeRequest, 'status'>;
  hasExecutePermission: boolean;
}): RuleDecision {
  if (!context.hasExecutePermission) {
    return deny(
      'permission',
      '缺少「执行权益变更」权限（entitlement.execute），无法执行',
    );
  }
  if (context.changeRequest.status !== 'approved') {
    return deny(
      'approval_required',
      '该变更申请尚未审批通过，不能执行。请先由具备 entitlement.approve 的同事审批。',
    );
  }
  return ALLOW;
}

/** 重试可用性：只有 `failed` 可重试，且另需 `tenant.retry`（契约 §5.6）。 */
export function canRetryChangeRequest(context: {
  changeRequest: Pick<EntitlementChangeRequest, 'status'>;
  hasExecutePermission: boolean;
  hasTenantRetryPermission: boolean;
}): RuleDecision {
  if (!context.hasExecutePermission) {
    return deny(
      'permission',
      '缺少「执行权益变更」权限（entitlement.execute），无法重试',
    );
  }
  if (!context.hasTenantRetryPermission) {
    return deny(
      'permission',
      '缺少「重试失败命令」权限（tenant.retry），无法重试',
    );
  }
  if (context.changeRequest.status !== 'failed') {
    return deny('state', '只有「执行失败」的变更申请可以重试');
  }
  return ALLOW;
}

/** 原因必填校验（审批/执行/重试/取消、以及所有变更申请都必须填原因）。 */
export interface ReasonValidation {
  message?: string;
  ok: boolean;
  value: string;
}

export const REASON_MAX_LENGTH = 500;

export function validateEntitlementReason(raw: string): ReasonValidation {
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

/**
 * 永久授权的前置校验（契约 §3.5 CHECK `(license_mode='perpetual') = (valid_to IS NULL)`）。
 * 前后端同一约束：永久授权不能填到期日，限期授权必须填。
 */
export function validateLicenseTerm(input: {
  licenseMode: 'perpetual' | 'term';
  validFrom?: string;
  validTo?: string;
}): RuleDecision {
  const validTo = input.validTo?.trim() ?? '';
  if (input.licenseMode === 'perpetual' && validTo !== '') {
    return deny(
      'state',
      '永久授权的到期日必须留空（永久授权 ≠ 永久更新，维护期请单独填写）',
    );
  }
  if (input.licenseMode === 'term' && validTo === '') {
    return deny('state', '限期授权必须填写到期日');
  }
  if (validTo !== '' && input.validFrom && validTo < input.validFrom) {
    return deny('state', '到期日不能早于生效日');
  }
  return ALLOW;
}

/** 快照不可变的界面说明（所有快照视图共用，避免各页文案不一致）。 */
export const SNAPSHOT_IMMUTABLE_NOTE =
  '权益快照仅追加、不可修改：发放后的历史快照保持原样，任何权益变化只能新增变更申请。';
