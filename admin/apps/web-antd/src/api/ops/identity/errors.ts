/**
 * identity-audit 域错误呈现映射。
 *
 * 契约约束（`Docs/ops-api-contract.md` §6）：前端**不解析**后端 `message`
 * （英文内部文案），只按 `code` + `details.reason` 映射中文，并把 `requestId`
 * 交给运营与后端日志对账。
 *
 * 本域特有的两条：
 * - 409 是常态而非异常：两个人同时改同一个成员/角色，后提交者的 `version` 已过期。
 *   一律提示「刷新后重试」并要求重新拉取，**不许**本地覆盖或静默重试。
 * - `LAST_ROLE` / `LAST_ADMIN` 是**正确的拒绝**，不是系统故障：文案要说清「为什么不能这么做」，
 *   而不是「操作失败」——否则运营会反复重试同一个被规则挡住的动作。
 */
import { OpsApiError, toOpsApiError } from '#/api/adapter/errors';

export type IdentityErrorKind =
  | 'conflict'
  | 'network'
  | 'not_found'
  | 'permission'
  | 'unknown'
  | 'validation';

export interface FieldIssue {
  message?: string;
  path: string;
}

export interface IdentityErrorView {
  /** 是否可原样重试（网络/5xx/429）。冲突类必须刷新后重走流程，不算「可重试」。 */
  canRetry: boolean;
  description: string;
  /** 400 时的字段级提示（契约 §2.4 `details.issues` 只含 path 与 code）。 */
  issues: FieldIssue[];
  kind: IdentityErrorKind;
  reason?: string;
  requestId?: string;
  /** 冲突后必须重新拉取（禁止用本地旧快照覆盖）。 */
  shouldRefresh: boolean;
  title: string;
}

/** `details.reason` → 本域文案（契约 §6.4 词表）。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  LAST_ADMIN: '这是最后一个具备账号管理权限的有效账号，移除后没人能再管账号',
  LAST_ROLE: '每个运营成员至少保留一个角色',
  OPS_MEMBER_INACTIVE: '运营账号已停用或尚未激活，请联系管理员',
  OPS_MEMBER_MISSING: '当前账号不是运营成员，请联系管理员开通用权',
};

const KIND_TITLE: Readonly<Record<IdentityErrorKind, string>> = {
  conflict: '数据已被他人修改',
  network: '网络请求失败',
  not_found: '记录不存在',
  permission: '没有执行该操作的权限',
  unknown: '操作失败',
  validation: '提交内容有误',
};

function readIssues(details: unknown): FieldIssue[] {
  if (typeof details !== 'object' || details === null) {
    return [];
  }
  const value = (details as Record<string, unknown>).issues;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : 'unknown';
    const message =
      typeof record.message === 'string' ? record.message : undefined;
    return [message ? { message, path } : { path }];
  });
}

function classify(apiError: OpsApiError): IdentityErrorKind {
  if (apiError.status === 409) {
    return 'conflict';
  }
  if (apiError.status === 403) {
    return 'permission';
  }
  if (apiError.status === 404) {
    return 'not_found';
  }
  if (apiError.status === 400 || apiError.code === 'VALIDATION_ERROR') {
    return 'validation';
  }
  if (apiError.kind !== 'http') {
    return 'network';
  }
  return 'unknown';
}

/** 把任意异常收敛为可直接渲染的错误视图。 */
export function describeIdentityError(error: unknown): IdentityErrorView {
  const apiError = error instanceof OpsApiError ? error : toOpsApiError(error);
  const kind = classify(apiError);
  const reason = apiError.reason;
  const reasonText = reason ? REASON_TEXT[reason] : undefined;
  const issues = readIssues(apiError.details);

  // reason 优先于 code 文案：`LAST_ADMIN` 比「当前状态不允许此操作」具体得多。
  const description = reasonText ?? apiError.userMessage;

  return {
    canRetry: kind === 'network',
    description,
    issues,
    kind,
    reason,
    requestId: apiError.requestId,
    // 版本冲突（无 reason）与状态冲突（带 reason 的规则拒绝）处理方式不同：
    // 前者刷新后重试通常能成，后者重试仍会被同一规则拒绝。
    shouldRefresh: kind === 'conflict' && reason === undefined,
    title: KIND_TITLE[kind],
  };
}

/** 字段级提示查找（表单就地标红用）。 */
export function issueFor(
  view: IdentityErrorView | null,
  path: string,
): string | undefined {
  return view?.issues.find((item) => item.path === path)?.message;
}
