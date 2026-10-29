/**
 * 部署域错误呈现映射。
 *
 * 契约约束（`Docs/ops-api-contract.md` §6）：前端**不得**解析后端 `message`
 * （英文内部文案），只能按 `code` + `details.reason` 映射中文，并把 `requestId`
 * 交给运营与后端日志对账。
 *
 * 部署域额外要求：
 * - `VERSION_MISMATCH`（409 `STATE_CONFLICT`）：实例当前版本已变更 → 必须刷新后基于
 *   最新版本重新登记，**不得**用本地值覆盖（源码参考门 §5.3）；
 * - 同客户同名实例（409 `CONFLICT`）→ 刷新列表后换个名称，不能静默改名重试；
 * - 403 必须区分「运营成员失效」与「缺少 deployment.write」。
 */
import { OpsApiError, toOpsApiError } from '#/api/adapter/errors';

export type DeploymentErrorKind =
  | 'conflict'
  | 'network'
  | 'not_found'
  | 'permission'
  | 'unknown'
  | 'validation';

export interface DeploymentErrorView {
  /** 是否可原样重试（网络/5xx）。冲突类必须刷新后重走流程，不算「可重试」。 */
  canRetry: boolean;
  description: string;
  kind: DeploymentErrorKind;
  reason?: string;
  requestId?: string;
  /** 冲突后需要重新拉取当前数据（禁止用本地旧值覆盖）。 */
  shouldRefresh: boolean;
  title: string;
}

/** `details.reason` → 部署场景文案（契约 §6.4 词表 + 可操作建议）。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  VERSION_MISMATCH:
    '实例当前版本与提交的升级前版本不一致（可能刚有人登记过升级），请刷新后按最新版本重新登记',
  REFERENCE_CUSTOMER_MISMATCH:
    '引用的合同、授权或实例不属于该客户，请重新选择客户后重试',
  OPS_MEMBER_INACTIVE: '运营账号已停用或尚未激活，请联系管理员',
  OPS_MEMBER_MISSING: '当前账号不是运营成员，请联系管理员开通用权',
};

function build(
  view: Omit<DeploymentErrorView, 'canRetry' | 'shouldRefresh'> &
    Partial<Pick<DeploymentErrorView, 'canRetry' | 'shouldRefresh'>>,
): DeploymentErrorView {
  return {
    canRetry: view.canRetry ?? false,
    shouldRefresh: view.shouldRefresh ?? false,
    ...view,
  };
}

/**
 * 把任意异常收敛为可直接渲染的部署错误视图。
 * 已知形态（`OpsApiError`）走精确映射；未知异常不允许兜底成成功形状。
 */
export function describeDeploymentError(error: unknown): DeploymentErrorView {
  const apiError = error instanceof OpsApiError ? error : toOpsApiError(error);
  const reason = apiError.reason;
  const reasonText = reason ? REASON_TEXT[reason] : undefined;
  const requestId = apiError.requestId;

  if (apiError.kind === 'network' || apiError.kind === 'timeout') {
    return build({
      canRetry: true,
      description:
        '请求没有收到服务端响应，结果未知。请先刷新详情确认这次登记是否已生效，再决定是否重试——重复登记会产生两条升级记录。',
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
    return build({
      description: requestId
        ? `${reasonText ?? '当前账号没有执行该动作的权限'}（请求 ID：${requestId}）`
        : (reasonText ??
          '当前账号没有执行该动作的权限（需要 deployment.write），请联系运营管理员'),
      kind: 'permission',
      reason,
      requestId,
      title: '无操作权限',
    });
  }

  if (apiError.status === 404) {
    return build({
      canRetry: true,
      description:
        '实例或记录不存在（也可能已退役归档），请刷新列表后重新选择。',
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
    if (reason === 'VERSION_MISMATCH') {
      return build({
        description:
          '数据已变化：实例的当前版本已被他人推进，你提交的升级前版本已过期。请刷新后按最新版本重新登记（系统不会用本地旧值覆盖）。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '版本已变化，请刷新后重试',
      });
    }
    return build({
      description: `${reasonText ?? '当前状态不允许该操作'}。请刷新后确认最新状态，不要用本地旧值覆盖。`,
      kind: 'conflict',
      reason,
      requestId,
      shouldRefresh: true,
      title: '数据已变化，请刷新后重试',
    });
  }

  if (apiError.status === 400) {
    return build({
      description:
        reasonText ?? '提交内容未通过校验，请检查必填项、日期与版本号格式。',
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
        '服务端处理失败，未确认是否已生效。请刷新详情确认结果后再重试，避免重复登记升级记录。',
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
export function isDeploymentRefreshRequired(error: unknown): boolean {
  return describeDeploymentError(error).shouldRefresh;
}
