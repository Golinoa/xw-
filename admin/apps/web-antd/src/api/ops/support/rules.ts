/**
 * 工单状态机与动作守卫（前端呈现 + 提交前拦截）。
 *
 * 为什么前端再写一遍状态机：
 * 1. 服务端是唯一权威，非法迁移一律 409 `STATE_CONFLICT` + `details.allowedActions`；
 *    但页面必须**只渲染当前状态允许的动作**，不能让运营点到一个必然失败的按钮。
 * 2. 「终态必须填原因」是前置守卫（源码参考门 §4.1）：不填原因就不发请求，
 *    而不是发出去等服务端拒。
 * 3. 「等待」必须有 `waitingOn`、「解决」必须有 `resolutionSummary`（契约 §3.8 守卫），
 *    这两个字段是工单可追溯性的核心事实，缺了就无法解释「在等谁、怎么解决的」。
 *
 * 本文件不发明动作：动作名、所需权限码、允许的当前态全部来自契约 §3.8 / §5.8。
 * 动作表与「终态例外动作」分开导出：
 * - `ticketStatusActions()` 是**常规处置**动作，`closed` 返回空数组（终态无常规动作）；
 * - `ticketReopenAction()` 是终态工单的**例外**入口（契约 §3.8 允许 `resolved`/`closed`
 *   重开，需 `ticket.close` 且必须填原因）。分开展示是为了避免「已关闭工单还有一堆
 *   处置按钮」的误读，同时不丢掉契约允许的重开能力。
 */
import type {
  TicketAction,
  TicketStatus,
  TicketTransitionInput,
} from './types';

import type { OpsPermission } from '#/constants/permissions';

import {
  isHighRiskPermission,
  OPS_PERMISSION,
  OPS_PERMISSION_LABEL,
} from '#/constants/permissions';

/** 拒绝原因码：稳定标识，便于单测断言，不依赖中文文案。 */
export type TicketDenyCode =
  | 'identity_unknown'
  | 'permission'
  | 'reason'
  | 'state'
  | 'validation';

export interface TicketDecision {
  allowed: boolean;
  code?: TicketDenyCode;
  /** 面向运营的说明，可直接展示。 */
  message?: string;
}

const ALLOW: TicketDecision = { allowed: true };

function deny(code: TicketDenyCode, message: string): TicketDecision {
  return { allowed: false, code, message };
}

/** 一个可执行的状态动作。 */
export interface TicketActionDef {
  action: TicketAction;
  /** 是否不可撤销/影响对外承诺（关闭、重开），需要二次确认。 */
  destructive: boolean;
  /** 走哪个端点：`assign` 是独立端点，其余走 `transition`（契约 §5.8）。 */
  endpoint: 'assign' | 'transition';
  /** 属于终态例外动作（仅重开）。 */
  exception: boolean;
  /** 是否命中 `isHighRiskPermission()` 清单。 */
  highRisk: boolean;
  key: string;
  label: string;
  permission: OpsPermission;
  /** 契约 §3.8 守卫：必须给 `reason`。 */
  requiresReason: boolean;
  /** 契约 §3.8 守卫：必须给 `resolutionSummary`。 */
  requiresResolution: boolean;
  /** 契约 §3.8 守卫：必须给 `waitingOn`。 */
  requiresWaitingOn: boolean;
  targetStatus: TicketStatus;
}

const ACTION_LABEL: Readonly<Record<TicketAction, string>> = {
  assign: '分派',
  close: '关闭工单',
  reopen: '重开工单',
  resolve: '标记已解决',
  resume: '恢复处理',
  start: '开始处理',
  wait: '转入等待',
};

/**
 * 动作 → 权限（契约 §3.8 状态机表的「权限」列 + §5.8 transition 行）。
 *
 * `reopen` 用 `ticket.close`（契约表：`resolved`/`closed` --reopen--> 需 `ticket.close`）。
 */
const ACTION_PERMISSION: Readonly<Record<TicketAction, OpsPermission>> = {
  assign: OPS_PERMISSION.TICKET_ASSIGN,
  close: OPS_PERMISSION.TICKET_CLOSE,
  reopen: OPS_PERMISSION.TICKET_CLOSE,
  resolve: OPS_PERMISSION.TICKET_UPDATE,
  resume: OPS_PERMISSION.TICKET_UPDATE,
  start: OPS_PERMISSION.TICKET_UPDATE,
  wait: OPS_PERMISSION.TICKET_UPDATE,
};

function makeAction(
  action: TicketAction,
  targetStatus: TicketStatus,
  overrides: Partial<TicketActionDef> = {},
): TicketActionDef {
  const permission = ACTION_PERMISSION[action];
  return {
    action,
    destructive: action === 'close' || action === 'reopen',
    endpoint: action === 'assign' ? 'assign' : 'transition',
    exception: false,
    highRisk: isHighRiskPermission(permission),
    key: action,
    label: ACTION_LABEL[action],
    permission,
    requiresReason: action === 'close' || action === 'reopen',
    requiresResolution: action === 'resolve',
    requiresWaitingOn: action === 'wait',
    targetStatus,
    ...overrides,
  };
}

/** 当前状态的**常规**可用动作（契约 §3.8 状态机表）。 */
export function ticketStatusActions(
  status: string | TicketStatus,
): TicketActionDef[] {
  switch (status) {
    case 'assigned': {
      return [makeAction('start', 'in_progress')];
    }
    // `closed` 是终态：无常规动作（重开属于例外入口，见 `ticketReopenAction`）。
    case 'closed': {
      return [];
    }
    case 'in_progress': {
      return [makeAction('wait', 'waiting'), makeAction('resolve', 'resolved')];
    }
    case 'new': {
      return [makeAction('assign', 'assigned')];
    }
    case 'resolved': {
      return [makeAction('close', 'closed')];
    }
    case 'waiting': {
      return [
        makeAction('resume', 'in_progress'),
        makeAction('resolve', 'resolved'),
      ];
    }
    default: {
      // 未知状态：不猜可用动作（契约 §2.6 / §3.8「非法迁移一律 409」）。
      return [];
    }
  }
}

/** 终态工单的例外动作：仅重开（契约 §3.8「可重开，不可删除」）。 */
export function ticketReopenAction(
  status: string | TicketStatus,
): null | TicketActionDef {
  if (status === 'resolved' || status === 'closed') {
    return makeAction('reopen', 'in_progress', {
      exception: true,
      label: '重开工单（记录原因）',
    });
  }
  return null;
}

/** 动作集：本地状态机 + 服务端 `allowedActions` 的交集，附带漂移信息。 */
export interface TicketActionSet {
  actions: TicketActionDef[];
  /** 本地有、但服务端 allowedActions 未包含的动作（按钮禁用并说明原因）。 */
  blockedByServer: string[];
  /** 服务端返回但本地状态机不认识的动作码（契约漂移提示，不渲染按钮）。 */
  unknownServerActions: string[];
}

/**
 * 计算可渲染的动作集。
 *
 * - 未提供 `serverAllowedActions`（契约定为可选）时按本地状态机渲染；
 * - 提供了就取交集：服务端说不能做的动作**不渲染**，服务端多出来的动作只提示不渲染
 *   （不猜它的语义）；
 * - 交集为空但本地有动作时，界面提示「请刷新」，因为通常是他人已流转。
 */
export function resolveTicketActions(
  status: string | TicketStatus,
  serverAllowedActions?: null | readonly string[],
): TicketActionSet {
  const local = ticketStatusActions(status);
  const reopen = ticketReopenAction(status);
  const candidates = reopen ? [...local, reopen] : local;

  if (!serverAllowedActions) {
    return {
      actions: candidates,
      blockedByServer: [],
      unknownServerActions: [],
    };
  }

  const serverSet = new Set(
    serverAllowedActions.map((item) => item.toLowerCase()),
  );
  const known = new Set(candidates.map((item) => item.action));
  return {
    actions: candidates.filter((item) => serverSet.has(item.action)),
    blockedByServer: candidates
      .filter((item) => !serverSet.has(item.action))
      .map((item) => item.action),
    unknownServerActions: [...serverSet].filter(
      (item) => !known.has(item as TicketAction),
    ),
  };
}

/** 动作所需权限码的中文说明（复用权限目录的唯一真源）。 */
export function ticketPermissionLabel(permission: OpsPermission): string {
  return OPS_PERMISSION_LABEL[permission] ?? permission;
}

/** 原因长度上限（与后端 `reason` 校验一致）。 */
export const TICKET_REASON_MAX_LENGTH = 500;

export interface ReasonValidation {
  message?: string;
  ok: boolean;
  value: string;
}

/** 终态/重开原因校验：空串与纯空白一律拒绝（不发请求）。 */
export function validateTicketReason(raw: string): ReasonValidation {
  const value = raw.trim();
  if (value === '') {
    return {
      message: '请填写原因：关闭与重开都必须留下可追溯的说明（会写入时间线）',
      ok: false,
      value,
    };
  }
  if (value.length > TICKET_REASON_MAX_LENGTH) {
    return {
      message: `原因不能超过 ${TICKET_REASON_MAX_LENGTH} 字`,
      ok: false,
      value,
    };
  }
  return { ok: true, value };
}

/** 提交前的完整校验结果。 */
export interface TransitionValidation {
  /** 字段级错误（键为字段名，供表单逐项标红）。 */
  errors: Partial<Record<'reason' | 'resolutionSummary' | 'waitingOn', string>>;
  ok: boolean;
}

type TransitionPayload = Partial<
  Pick<TicketTransitionInput, 'reason' | 'resolutionSummary' | 'waitingOn'>
>;

/**
 * 动作守卫校验（契约 §3.8 守卫 + 前置门禁 §4.1）。
 *
 * 顺序固定：先看动作是否需要原因/等待对象/解决说明，再校验内容。
 * 返回字段级错误而不是抛错——页面据此标红并**阻止发请求**。
 */
export function validateTicketAction(
  action: TicketActionDef,
  payload: TransitionPayload,
): TransitionValidation {
  const errors: TransitionValidation['errors'] = {};

  if (action.requiresReason) {
    const reason = validateTicketReason(payload.reason ?? '');
    if (!reason.ok) {
      errors.reason = reason.message;
    }
  } else if ((payload.reason ?? '').length > TICKET_REASON_MAX_LENGTH) {
    errors.reason = `原因不能超过 ${TICKET_REASON_MAX_LENGTH} 字`;
  }

  if (action.requiresWaitingOn) {
    const waitingOn = (payload.waitingOn ?? '').trim();
    if (waitingOn === '') {
      errors.waitingOn =
        '转入等待必须写明等待对象（等待客户回复/等待第三方处理等）';
    }
  }

  if (action.requiresResolution) {
    const summary = (payload.resolutionSummary ?? '').trim();
    if (summary === '') {
      errors.resolutionSummary = '标记已解决必须填写解决说明（关闭摘要的来源）';
    }
  }

  return { errors, ok: Object.keys(errors).length === 0 };
}

/** 分派前置守卫（契约 §5.8：`closed` 不可直接分派 → 409 `STATE_CONFLICT`）。 */
export function canAssignTicket(input: {
  hasAssignPermission: boolean;
  status: string | TicketStatus;
}): TicketDecision {
  if (!input.hasAssignPermission) {
    return deny(
      'permission',
      '缺少「分派/改派工单」权限（ticket.assign），无法分派',
    );
  }
  if (input.status === 'closed') {
    return deny(
      'state',
      '已关闭的工单不能直接分派，请先重开（重开需填写原因）',
    );
  }
  return ALLOW;
}

/** 页面级读权限守卫（无 `ticket.read` 时不展示任何工单内容）。 */
export function canViewTicket(input: {
  hasReadPermission: boolean;
}): TicketDecision {
  if (!input.hasReadPermission) {
    return deny('permission', '缺少「查看工单与时间线」权限（ticket.read）');
  }
  return ALLOW;
}

/** 可编辑字段的前置守卫（已关闭工单只能重开，不能改内容）。 */
export function canEditTicket(input: {
  hasUpdatePermission: boolean;
  status: string | TicketStatus;
}): TicketDecision {
  if (!input.hasUpdatePermission) {
    return deny(
      'permission',
      '缺少「处理说明、编辑工单字段」权限（ticket.update），无法编辑',
    );
  }
  if (input.status === 'closed') {
    return deny('state', '已关闭的工单不可编辑，如需继续处理请先重开');
  }
  return ALLOW;
}

/** 追加备注的前置守卫（契约 §5.8：`closed` 只允许 `reopen`）。 */
export function canCommentTicket(input: {
  hasUpdatePermission: boolean;
  status: string | TicketStatus;
}): TicketDecision {
  if (!input.hasUpdatePermission) {
    return deny(
      'permission',
      '缺少「处理说明、编辑工单字段」权限（ticket.update），无法添加备注',
    );
  }
  if (input.status === 'closed') {
    return deny('state', '已关闭的工单不再接受备注，如需继续沟通请先重开');
  }
  return ALLOW;
}

/** 时间线不可变的界面说明（所有工单视图共用，避免文案不一致）。 */
export const TICKET_TIMELINE_IMMUTABLE_NOTE =
  '时间线只追加、不可修改或删除：分派、状态变更、备注都按发生顺序留痕，历史结论不会被编辑覆盖。';
