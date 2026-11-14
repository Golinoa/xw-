/**
 * 账款域错误呈现映射。
 *
 * 契约约束（`Docs/ops-api-contract.md` §6）：前端**不得**解析后端 `message`
 * （英文内部文案），只能按 `code` + `details.reason` 映射中文，并且必须把
 * `requestId` 交给运营，便于与后端日志对账。
 *
 * 金融场景额外要求：
 * - 409 冲突必须明确「余额/版本已变化，请刷新后重试」，并触发重新拉取；
 * - 403 职责分离必须说清是"登记人不能自审"，而不是笼统的"没有权限"。
 */
import { OpsApiError, toOpsApiError } from '#/api/adapter/errors';

export type BillingErrorKind =
  | 'conflict'
  | 'network'
  | 'not_found'
  | 'permission'
  | 'unknown'
  | 'validation';

export interface BillingErrorView {
  /** 是否提示调用方重新拉取数据（并发冲突必须刷新，避免用户拿旧余额重试）。 */
  canRetry: boolean;
  description: string;
  kind: BillingErrorKind;
  reason?: string;
  requestId?: string;
  /** 冲突后需要刷新当前页面数据。 */
  shouldRefresh: boolean;
  title: string;
}

/** `details.reason` → 账款场景文案（叠加在契约 §6.4 词表之上，补充可操作建议）。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  CURRENCY_MISMATCH: '核销双方币种不一致',
  CUSTOMER_MISMATCH: '核销双方客户不一致',
  HAS_ALLOCATIONS: '该收款仍有有效核销，请先撤销核销再冲正',
  RECEIVABLE_EXCEEDED: '本次核销金额超过该期应收余额',
  RECEIVABLE_SETTLED: '该期应收已结清，不能展期',
  RECEIPT_EXCEEDED: '本次核销金额超过收款可分配金额',
  RECEIPT_NOT_APPROVED: '该收款尚未审核，审核通过后才能计入实收并核销',
  REFUND_EXCEEDED: '退款金额超过可退款净额',
  SEGREGATION_OF_DUTY: '登记人不能审核自己登记的收款（职责分离）',
  PLAN_TOTAL_MISMATCH: '应收计划合计与合同金额不一致',
};

const CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'HAS_ALLOCATIONS',
  'RECEIPT_EXCEEDED',
  'RECEIPT_NOT_APPROVED',
  'RECEIVABLE_EXCEEDED',
  'RECEIVABLE_SETTLED',
  'REFUND_EXCEEDED',
]);

function build(
  view: Omit<BillingErrorView, 'canRetry' | 'shouldRefresh'> &
    Partial<Pick<BillingErrorView, 'canRetry' | 'shouldRefresh'>>,
): BillingErrorView {
  return {
    canRetry: view.canRetry ?? false,
    shouldRefresh: view.shouldRefresh ?? false,
    ...view,
  };
}

/**
 * 把任意异常收敛为可直接渲染的账款错误视图。
 * 已知形态（`OpsApiError`）走精确映射；未知异常不允许兜底成成功形状。
 */
export function describeBillingError(error: unknown): BillingErrorView {
  const apiError = error instanceof OpsApiError ? error : toOpsApiError(error);
  const reason = apiError.reason;
  const reasonText = reason ? REASON_TEXT[reason] : undefined;
  const requestId = apiError.requestId;

  if (apiError.kind === 'network' || apiError.kind === 'timeout') {
    return build({
      canRetry: true,
      description:
        '请求没有收到服务端响应，结果未知。请先刷新列表确认这笔操作是否已生效，再决定是否重试。',
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
        : (reasonText ?? '当前账号没有执行该动作的权限，请联系运营管理员'),
      kind: 'permission',
      reason,
      requestId,
      title: reason === 'SEGREGATION_OF_DUTY' ? '职责分离限制' : '无操作权限',
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

  // 409：并发/幂等冲突。金额类冲突一律要求刷新，避免用旧余额重新提交。
  if (
    apiError.status === 409 &&
    (apiError.code === 'STATE_CONFLICT' ||
      apiError.code === 'CONFLICT' ||
      apiError.code === 'IDEMPOTENCY_CONFLICT')
  ) {
    if (apiError.code === 'IDEMPOTENCY_CONFLICT') {
      return build({
        description:
          '该操作此前已提交过且请求内容不同，系统未重复执行。请刷新列表确认当前状态后再决定是否重新提交。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '重复提交被拒绝',
      });
    }
    if (apiError.code === 'CONFLICT') {
      return build({
        description:
          '记录已被他人修改（版本或唯一约束冲突）。请刷新后基于最新数据重新操作。',
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '数据已变更',
      });
    }
    if (reason && CONFLICT_REASONS.has(reason)) {
      return build({
        description: `${reasonText ?? '当前状态不允许该操作'}。余额可能已被其他操作改动，请刷新后重试。`,
        kind: 'conflict',
        reason,
        requestId,
        shouldRefresh: true,
        title: '余额已变化',
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
        reasonText ?? '提交内容未通过校验，请检查金额、日期与必填项。',
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
        '服务端处理失败，未确认是否已生效。请刷新列表确认结果后再重试，避免重复提交。',
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
export function isRefreshRequired(error: unknown): boolean {
  return describeBillingError(error).shouldRefresh;
}
