/**
 * 权益域错误呈现映射。
 *
 * 契约约束（`Docs/ops-api-contract.md` §6）：前端**不得**解析后端 `message`
 * （英文内部文案），只能按 `code` + `details.reason` 映射中文，并把 `requestId`
 * 交给运营与后端日志对账。
 *
 * 权益域额外要求：
 * - 未审批即执行 → 409 `STATE_CONFLICT` + `APPROVAL_REQUIRED`，必须说明「先审批再执行」；
 * - 版本/并发冲突 → 提示「数据已变化，请刷新后重试」并重新拉取，禁止本地覆盖
 *   （源码参考门 §3.1/§3.5）；
 * - 403 `SEGREGATION_OF_DUTY` 必须说清「申请人不能审批自己的申请」。
 */
import { OpsApiError, toOpsApiError } from '#/api/adapter/errors';

export type EntitlementErrorKind =
  | 'conflict'
  | 'network'
  | 'not_found'
  | 'permission'
  | 'unknown'
  | 'validation';

export interface EntitlementErrorView {
  /** 是否可原样重试（网络/5xx）。冲突类必须刷新后重走流程，不算「可重试」。 */
  canRetry: boolean;
  description: string;
  kind: EntitlementErrorKind;
  reason?: string;
  requestId?: string;
  /** 冲突后需要重新拉取当前数据（禁止用本地旧值覆盖）。 */
  shouldRefresh: boolean;
  title: string;
}

/** `details.reason` → 权益场景文案（契约 §6.4 词表 + 可操作建议）。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  APPROVAL_REQUIRED: '该变更尚未审批通过，不能执行',
  PERMANENT_ERROR: '该同步命令为永久性失败，不能重试，请改为新建变更申请',
  SEGREGATION_OF_DUTY:
    '申请人不能审批自己提交的变更（职责分离），请转交他人审批',
  VERSION_MISMATCH: '数据版本已变化，请刷新后重试',
  OPS_MEMBER_INACTIVE: '运营账号已停用或尚未激活，请联系管理员',
  OPS_MEMBER_MISSING: '当前账号不是运营成员，请联系管理员开通用权',
  SYNC_TARGET_UNAVAILABLE: '租户系统暂时不可达，命令已排队，可稍后查看执行状态',
};

/** 需要「刷新后重试」的冲突原因（都是并发/状态被他人推进造成的）。 */
const CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'APPROVAL_REQUIRED',
  'PERMANENT_ERROR',
  'VERSION_MISMATCH',
]);

function build(
  view: Omit<EntitlementErrorView, 'canRetry' | 'shouldRefresh'> &
    Partial<Pick<EntitlementErrorView, 'canRetry' | 'shouldRefresh'>>,
): EntitlementErrorView {
  return {
    canRetry: view.canRetry ?? false,
    shouldRefresh: view.shouldRefresh ?? false,
    ...view,
  };
}

/**
 * 把任意异常收敛为可直接渲染的权益错误视图。
 * 已知形态（`OpsApiError`）走精确映射；未知异常不允许兜底成成功形状。
 */
export function describeEntitlementError(error: unknown): EntitlementErrorView {
  const apiError = error instanceof OpsApiError ? error : toOpsApiError(error);
  const reason = apiError.reason;
  const reasonText = reason ? REASON_TEXT[reason] : undefined;
  const requestId = apiError.requestId;

  if (apiError.kind === 'network' || apiError.kind === 'timeout') {
    return build({
      canRetry: true,
      description:
        '请求没有收到服务端响应，结果未知。请先刷新详情确认这次操作是否已生效，再决定是否重试——权益变更可能已经生成租户命令。',
      kind: 'network',
      requestId,
      title: '网络异常',
    });
  }

  if (apiError.status === 401) {
    return build({
      description: '登录状态已失效，请重新登录后重试。',
      kind: 'permission',
      requestId,
      title: '登录状态已失效',
    });
  }

  if (apiError.status === 403) {
    const title =
      reason === 'SEGREGATION_OF_DUTY' ? '职责分离限制' : '无操作权限';
    return build({
      description: requestId
        ? `${reasonText ?? '当前账号没有执行该动作的权限'}（请求 ID：${requestId}）`
        : (reasonText ?? '当前账号没有执行该动作的权限，请联系运营管理员'),
      kind: 'permission',
      reason,
      requestId,
      title,
    });
  }

  if (apiError.status === 404) {
    return build({
      canRetry: true,
      description: '记录不存在或已被移除，请刷新列表后重新选择。',
      kind: 'not_found',
      requestId,
      title: '记录不存在',
    });
  }

  if (
    apiError.status === 409 &&
    (apiError.code === 'STATE_CONFLICT' ||
      apiError.code === 'CONFLICT' ||
      apiError.code === 'IDEMPOTENCY_CONFLICT')
  ) {
    if (apiError.code === 'IDEMPOTENCY_CONFLICT') {
      return build({
        description:
          '该操作此前已提交过且请求内容不同，系统未重复执行。请刷新详情确认当前状态后再决定是否重新提交。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '重复提交被拒绝',
      });
    }
    if (reason === 'APPROVAL_REQUIRED') {
      return build({
        description:
          '该变更申请尚未审批通过，服务端拒绝了本次执行。请刷新后确认审批状态，先由具备 entitlement.approve 的同事审批，再执行下发。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '需要先完成审批',
      });
    }
    if (reason === 'PERMANENT_ERROR') {
      return build({
        description:
          '同步命令被判定为永久性失败，不能重复重试。请刷新后新建一条变更申请（保留原失败记录作为历史）。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '不可重试的失败',
      });
    }
    if (
      apiError.code === 'CONFLICT' ||
      (reason && CONFLICT_REASONS.has(reason))
    ) {
      return build({
        description:
          '数据已变化（版本或状态被其他操作推进），请刷新后基于最新数据重新操作，系统不会用本地旧值覆盖。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '数据已变化',
      });
    }
    return build({
      description: `${reasonText ?? '当前状态不允许该操作'}。请刷新后确认最新状态。`,
      kind: 'conflict',
      reason,
      requestId,
      shouldRefresh: true,
      title: '状态冲突',
    });
  }

  if (apiError.status === 400) {
    return build({
      description:
        reasonText ?? '提交内容未通过校验，请检查必填项、日期与额度格式。',
      kind: 'validation',
      reason,
      requestId,
      title: '提交内容有误',
    });
  }

  if (apiError.status !== undefined && apiError.status >= 500) {
    return build({
      canRetry: true,
      description:
        '服务端处理失败，未确认是否已生效。请刷新详情确认结果后再重试，避免重复下发同步命令。',
      kind: 'unknown',
      requestId,
      title: '服务暂时不可用',
    });
  }

  return build({
    description: apiError.userMessage,
    kind: 'unknown',
    reason,
    requestId,
    title: '操作失败',
  });
}

/** 冲突类错误（409）需要重新拉取数据。 */
export function isEntitlementRefreshRequired(error: unknown): boolean {
  return describeEntitlementError(error).shouldRefresh;
}
