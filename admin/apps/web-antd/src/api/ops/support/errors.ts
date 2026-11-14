/**
 * 工单域错误呈现映射。
 *
 * 契约约束（`Docs/ops-api-contract.md` §6）：前端**不解析**后端 `message`
 * （英文内部文案），只按 `code` + `details.reason` 映射中文，并把 `requestId`
 * 交给运营与后端日志对账。
 *
 * 工单域额外要求：
 * - 409 是真实常态：两个运营同时处理同一工单，后提交者的 `version` 已过期。
 *   一律提示「数据已变化，请刷新后重试」并**重新拉取**，不许本地覆盖或静默重试；
 *   如果服务端给了 `details.allowedActions`，同时展示「当前最新可用动作」——
 *   这就是「他人已流转」的可读证据。
 * - 403 `FORBIDDEN` 必须说清缺少的动作码，便于找管理员开通。
 */
import { OpsApiError, toOpsApiError } from '#/api/adapter/errors';

export type TicketErrorKind =
  | 'conflict'
  | 'network'
  | 'not_found'
  | 'permission'
  | 'unknown'
  | 'validation';

export interface TicketErrorView {
  /** 服务端返回的当前可用动作（409 时用于说明「现在还能做什么」）。 */
  allowedActions: string[];
  /** 是否可原样重试（网络/5xx/429）。冲突类必须刷新后重走流程，不算「可重试」。 */
  canRetry: boolean;
  description: string;
  kind: TicketErrorKind;
  reason?: string;
  requestId?: string;
  /** 冲突后必须重新拉取（禁止用本地旧快照覆盖）。 */
  shouldRefresh: boolean;
  title: string;
}

/** `details.reason` → 工单场景文案（契约 §6.4 词表）。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  OPS_MEMBER_INACTIVE: '运营账号已停用或尚未激活，请联系管理员',
  OPS_MEMBER_MISSING: '当前账号不是运营成员，请联系管理员开通用权',
  REFERENCE_CUSTOMER_MISMATCH:
    '关联的租户任务/授权变更/部署记录不属于该工单客户',
  SEGREGATION_OF_DUTY: '该操作需要他人复核，提交人与确认人不能是同一人',
};

function readAllowedActions(details: unknown): string[] {
  if (typeof details !== 'object' || details === null) {
    return [];
  }
  const value = (details as Record<string, unknown>).allowedActions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function build(
  view: Omit<TicketErrorView, 'allowedActions' | 'canRetry' | 'shouldRefresh'> &
    Partial<
      Pick<TicketErrorView, 'allowedActions' | 'canRetry' | 'shouldRefresh'>
    >,
): TicketErrorView {
  return {
    allowedActions: view.allowedActions ?? [],
    canRetry: view.canRetry ?? false,
    shouldRefresh: view.shouldRefresh ?? false,
    ...view,
  };
}

/** 把任意异常收敛为可直接渲染的工单错误视图。 */
export function describeTicketError(error: unknown): TicketErrorView {
  const apiError = error instanceof OpsApiError ? error : toOpsApiError(error);
  const reason = apiError.reason;
  const reasonText = reason ? REASON_TEXT[reason] : undefined;
  const allowedActions = readAllowedActions(apiError.details);
  const requestId = apiError.requestId;
  const allowedText =
    allowedActions.length > 0
      ? `服务端返回的当前可用动作：${allowedActions.join('、')}。`
      : '';

  if (apiError.kind === 'network' || apiError.kind === 'timeout') {
    return build({
      canRetry: true,
      description:
        '请求没有收到服务端响应，结果未知。请先刷新详情确认这次操作是否已生效，再决定是否重试——重复提交可能产生两条时间线记录。',
      kind: 'network',
      requestId,
      reason,
      shouldRefresh: true,
      title: '网络异常，结果未知',
    });
  }

  if (apiError.code === 'CONFLICT' || apiError.code === 'STATE_CONFLICT') {
    const isState = apiError.code === 'STATE_CONFLICT';
    return build({
      allowedActions,
      description: `数据已变化，请刷新后重试。本页会自动重新拉取服务端最新状态${
        allowedText ? `；${allowedText}` : ''
      }`,
      kind: 'conflict',
      reason,
      requestId,
      shouldRefresh: true,
      title: isState ? '工单状态已变化' : '数据已变化',
    });
  }

  if (apiError.code === 'IDEMPOTENCY_CONFLICT') {
    return build({
      description:
        '同一操作被重复提交但内容不同（幂等键冲突），请刷新后重新确认再操作。',
      kind: 'conflict',
      reason,
      requestId,
      shouldRefresh: true,
      title: '重复提交被拒绝',
    });
  }

  if (apiError.status === 403 || apiError.code === 'FORBIDDEN') {
    return build({
      description:
        reasonText ??
        '当前账号没有执行该动作的权限。页面按钮的禁用状态只是呈现，真正的授权由服务端判定；请联系运营管理员开通对应动作码。',
      kind: 'permission',
      reason,
      requestId,
      title: '没有操作权限',
    });
  }

  if (apiError.status === 404 || apiError.code === 'NOT_FOUND') {
    return build({
      description:
        '工单不存在，或当前账号无权查看（服务端不区分这两种情况）。请确认链接是否来自本系统。',
      kind: 'not_found',
      reason,
      requestId,
      title: '工单不存在',
    });
  }

  if (apiError.code === 'VALIDATION_ERROR') {
    return build({
      description:
        reasonText ??
        '提交内容未通过服务端校验。请检查必填项（等待对象、解决说明、原因）后重试。',
      kind: 'validation',
      reason,
      requestId,
      title: '提交内容有误',
    });
  }

  if (apiError.status === 429 || apiError.code === 'RATE_LIMITED') {
    return build({
      canRetry: true,
      description: '操作过于频繁，服务端已限流。稍等片刻再试，不要连续点击。',
      kind: 'network',
      reason,
      requestId,
      title: '操作过于频繁',
    });
  }

  if (apiError.status !== undefined && apiError.status >= 500) {
    return build({
      canRetry: true,
      description:
        '服务端暂时不可用，本次操作结果未知。请先刷新详情确认时间线是否已追加，再决定是否重试。',
      kind: 'network',
      reason,
      requestId,
      shouldRefresh: true,
      title: '服务暂时不可用',
    });
  }

  return build({
    description: '操作失败，请稍后重试；若持续失败请把请求 ID 提供给后端排查。',
    kind: 'unknown',
    reason,
    requestId,
    title: '操作失败',
  });
}

/** 冲突后是否需要强制刷新（页面据此重新拉取详情并保留用户输入）。 */
export function isTicketRefreshRequired(error: unknown): boolean {
  return describeTicketError(error).shouldRefresh;
}
