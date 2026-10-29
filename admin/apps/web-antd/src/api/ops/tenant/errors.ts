/**
 * 租户交付域错误呈现映射。
 *
 * 契约约束（`Docs/ops-api-contract.md` §6）：前端**不得**解析后端 `message`，
 * 只能按 `code` + `details.reason` 映射中文，并且必须把 `requestId` 交给运营对账。
 *
 * 本域特有语义（交付正确性敏感）：
 * - 502 `SYNC_TARGET_UNAVAILABLE` **不是失败**：命令已入队（`pending`），
 *   必须展示为「已受理，结果待确认」，否则运营会误以为没开出去而重复下发；
 * - 409 `TENANT_MAPPING_CONFLICT` 只提示「不自动改绑」，**不提供**一键改绑入口；
 * - 409 `SYNC_VERSION_CONFLICT` 必须刷新映射详情后重试，禁止用本地版本覆盖；
 * - 409 `PERMANENT_ERROR` 明确说「不可重试」，避免运营反复点重试。
 */
import { OpsApiError, toOpsApiError } from '#/api/adapter/errors';

export type TenantErrorKind =
  | 'accepted'
  | 'conflict'
  | 'network'
  | 'not_found'
  | 'permission'
  | 'unknown'
  | 'validation';

export interface TenantErrorView {
  /** 是否为「已受理但不是成功」：调用方仍应刷新并保持待确认展示。 */
  accepted: boolean;
  /** 是否允许原样重试（网络类失败才允许原样重试，409 必须先刷新）。 */
  canRetry: boolean;
  description: string;
  kind: TenantErrorKind;
  reason?: string;
  requestId?: string;
  /** 冲突后必须重新拉取（映射详情 / 命令详情 / 列表）。 */
  shouldRefresh: boolean;
  title: string;
}

/** `details.reason` → 本域文案（叠加在契约 §6.4 词表之上，补充可操作建议）。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  APPROVAL_REQUIRED: '关联的权益变更申请尚未审批通过，不能下发命令',
  PERMANENT_ERROR:
    '该命令是永久性错误（业务规则拒绝），重试不会改变结果，需要修正数据后重新发起',
  SYNC_VERSION_CONFLICT:
    '映射的同步版本已变化（可能有人刚完成一次同步），本次命令未下发',
  TENANT_MAPPING_CONFLICT: '该 udone 租户已绑定其他商业客户，系统不会自动改绑',
};

function build(
  view: Omit<TenantErrorView, 'accepted' | 'canRetry' | 'shouldRefresh'> &
    Partial<Pick<TenantErrorView, 'accepted' | 'canRetry' | 'shouldRefresh'>>,
): TenantErrorView {
  return {
    accepted: view.accepted ?? false,
    canRetry: view.canRetry ?? false,
    shouldRefresh: view.shouldRefresh ?? false,
    ...view,
  };
}

/**
 * 把任意异常收敛为可直接渲染的租户交付错误视图。
 * 未知异常不会被兜底成「成功」或「已受理」——只有明确的 502 才是已受理。
 */
export function describeTenantError(error: unknown): TenantErrorView {
  const apiError = error instanceof OpsApiError ? error : toOpsApiError(error);
  const reason = apiError.reason;
  const reasonText = reason ? REASON_TEXT[reason] : undefined;
  const requestId = apiError.requestId;

  // 上游不可达但命令已入队：契约 §6.3 明确「运营侧不报失败」。
  if (apiError.code === 'SYNC_TARGET_UNAVAILABLE') {
    return build({
      accepted: true,
      description:
        '命令已写入并处于待执行状态，但租户系统暂时不可达，结果尚未确认。请稍后刷新命令详情查看执行结果，不要重复下发。',
      kind: 'accepted',
      reason,
      requestId,
      shouldRefresh: true,
      title: '已受理，结果待确认',
    });
  }

  if (apiError.kind === 'network' || apiError.kind === 'timeout') {
    return build({
      canRetry: true,
      description:
        '请求没有收到服务端响应，命令是否已下发未知。请先刷新命令列表确认是否已存在，再决定是否重试（重试会复用同一幂等键，不会重复开通）。',
      kind: 'network',
      requestId,
      title: '网络异常，结果未知',
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
        : (reasonText ?? '当前账号没有执行该动作的权限，请联系运营管理员'),
      kind: 'permission',
      reason,
      requestId,
      title: '无操作权限',
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

  if (apiError.status === 409) {
    if (apiError.code === 'IDEMPOTENCY_CONFLICT') {
      return build({
        description:
          '该幂等键此前提交过但请求内容不同，本次未执行。请刷新命令列表确认已有命令，再决定下一步。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '重复提交被拒绝',
      });
    }

    if (reason === 'TENANT_MAPPING_CONFLICT') {
      return build({
        description:
          '该 udone 租户已绑定其他商业客户。为保护客户数据边界，系统不会自动改绑；请核对租户 ID 是否填错，或联系对应客户负责人确认后再新建映射。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '租户已绑定其他客户',
      });
    }

    if (reason === 'PERMANENT_ERROR') {
      return build({
        description:
          '该命令被判定为永久性错误（业务规则拒绝），重试不会改变结果。请根据错误码修正数据后重新发起命令。',
        kind: 'conflict',
        reason,
        requestId,
        title: '永久性错误不可重试',
      });
    }

    if (reason === 'SYNC_VERSION_CONFLICT') {
      return build({
        description:
          '映射数据已变化（同步版本已被推进），本次命令未下发。页面正在重新拉取映射详情，请基于最新版本重新提交。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '数据已变化，请刷新后重试',
      });
    }

    if (reason === 'APPROVAL_REQUIRED') {
      return build({
        description:
          '关联的权益变更申请尚未审批通过。请先在「订阅与授权」完成审批，再下发命令。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '需要先完成审批',
      });
    }

    return build({
      description: `${reasonText ?? '当前状态不允许该操作'}。请刷新后基于最新状态重新操作。`,
      kind: 'conflict',
      reason,
      requestId,
      shouldRefresh: true,
      title: '状态冲突',
    });
  }

  if (apiError.status === 400) {
    return build({
      description: reasonText ?? '提交内容未通过校验，请检查必填项与格式。',
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
        '服务端处理失败，命令是否已下发未确认。请先刷新命令列表确认结果，再决定是否重试。',
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
export function isTenantRefreshRequired(error: unknown): boolean {
  return describeTenantError(error).shouldRefresh;
}

/** 是否属于「已受理但结果待确认」（502 上游不可达），调用方据此展示待确认而不是成功。 */
export function isTenantAccepted(error: unknown): boolean {
  return describeTenantError(error).accepted;
}
