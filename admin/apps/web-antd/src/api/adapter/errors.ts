/**
 * 后端错误码 → 用户可读中文文案 → 可恢复性判定。
 *
 * 后端错误体（`udone/apps/api/src/middleware/error-handler.ts`，只读核对）：
 * `{ code, message, requestId, details? }`，`requestId` 同时写响应头 `X-Request-Id`。
 * 前端**不得**展示后端 `message`（英文内部文案），也不得解析它的内容；
 * 只按 `code`（必要时叠加 `details.reason`）映射，契约见 `Docs/ops-api-contract.md` §6。
 */
import { isAxiosError } from '@vben/request';

import { readRequestMeta } from './request-meta';

/** 一次失败的分类，决定上层如何呈现与是否可重试。 */
export type OpsApiErrorKind = 'http' | 'network' | 'timeout' | 'unknown';

/** 前端自造的错误码（后端不会返回），用于网络层失败。 */
export const OPS_CLIENT_ERROR_CODE = {
  NETWORK: 'NETWORK_ERROR',
  TIMEOUT: 'REQUEST_TIMEOUT',
  UNKNOWN: 'UNKNOWN_ERROR',
} as const;

export type OpsClientErrorCode =
  (typeof OPS_CLIENT_ERROR_CODE)[keyof typeof OPS_CLIENT_ERROR_CODE];

const DEFAULT_ERROR_MESSAGE = '操作失败，请稍后重试';

/** 后端 `code` → 中文文案。键为契约 §6.2/§6.3 的错误码。 */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: '登录状态已失效，请重新登录',
  FORBIDDEN: '你没有执行此操作的权限',
  VALIDATION_ERROR: '提交内容有误，请检查标记的字段',
  NOT_FOUND: '记录不存在或已被移除',
  CONFLICT: '数据已变更，请刷新后重试',
  OBJECT_REFERENCED: '该记录仍有关联数据，无法执行此操作',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  STATE_CONFLICT: '当前状态不允许此操作',
  IDEMPOTENCY_CONFLICT: '该请求此前已提交过，请刷新后确认结果',
  SYNC_TARGET_UNAVAILABLE: '租户系统暂时不可达，命令已排队，可稍后查看执行状态',
  [OPS_CLIENT_ERROR_CODE.NETWORK]: '网络连接失败，请检查网络后重试',
  [OPS_CLIENT_ERROR_CODE.TIMEOUT]: '请求超时，请稍后重试',
  [OPS_CLIENT_ERROR_CODE.UNKNOWN]: DEFAULT_ERROR_MESSAGE,
};

/**
 * `details.reason` → 中文文案（契约 §6.4 词表，唯一真源）。
 * 命中 reason 时优先于 code 文案，因为 reason 更具体。
 */
const REASON_MESSAGES: Readonly<Record<string, string>> = {
  // ---- 会话与成员 ----
  OPS_MEMBER_MISSING: '当前账号不是运营成员，请联系管理员开通用权',
  OPS_MEMBER_INACTIVE: '运营账号已停用或尚未激活，请联系管理员',
  SEGREGATION_OF_DUTY: '该操作需要他人复核，登记人与审核人不能是同一人',
  // ---- STATE_CONFLICT ----
  APPROVAL_REQUIRED: '该操作需要先完成审批才能执行',
  CONTRACT_IMMUTABLE: '合同已生效或已终结，不能再直接修改，请走变更单',
  PERMANENT_ERROR: '该命令为永久性失败，不能重试',
  HAS_ALLOCATIONS: '收款仍存在有效核销，请先撤销核销再冲正',
  RECEIPT_NOT_APPROVED: '收款尚未审核，不能参与核销',
  RECEIPT_EXCEEDED: '本次核销金额超过收款可分配金额',
  RECEIVABLE_EXCEEDED: '本次核销金额超过该期应收余额',
  RECEIVABLE_SETTLED: '该期应收已结清，无法展期',
  REFUND_EXCEEDED: '退款金额超过可退款净额',
  VERSION_MISMATCH: '部署实例当前版本与提交的起始版本不一致，请刷新后重试',
  PACKAGE_RETIRED: '该套餐已停用，不能用于续约',
  RENEWAL_NOT_DUE: '原合同尚未到期或未终结，续约需要显式确认强制续约',
  LAST_ROLE: '不能移除运营账号的最后一个角色',
  LAST_ADMIN: '不能移除最后一个具备账号管理权限的有效账号',
  // ---- VALIDATION_ERROR ----
  PLAN_TOTAL_MISMATCH: '应收计划合计与合同金额不一致',
  CURRENCY_MISMATCH: '核销双方的币种不一致',
  CUSTOMER_MISMATCH: '核销双方的客户不一致',
  REFERENCE_CUSTOMER_MISMATCH: '引用的合同、租户或实例不属于该客户',
  // ---- CONFLICT ----
  TENANT_MAPPING_CONFLICT: '该外部租户已绑定其他客户，不能重复绑定',
};

export interface OpsApiErrorOptions {
  kind: OpsApiErrorKind;
  code: string;
  userMessage: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  /** 原始错误，仅用于日志，不对外暴露。 */
  raw?: unknown;
}

/**
 * 全站唯一的结构化 API 错误。
 *
 * 注意：它**不带** `response` 字段，因此 `RequestClient.request` 的
 * `throw error.response ? error.response.data : error` 会原样抛出本对象，
 * 不会被压成裸响应体（这是模板丢失状态码的根因）。
 */
export class OpsApiError extends Error {
  public readonly code: string;
  public readonly details: Record<string, unknown> | undefined;
  public readonly kind: OpsApiErrorKind;
  public readonly raw: unknown;
  public readonly reason: string | undefined;
  public readonly requestId: string | undefined;
  public readonly retryable: boolean;
  public readonly status: number | undefined;
  public readonly userMessage: string;

  /** 面向运营反馈的完整文案：主文案 + requestId 次级信息。 */
  public get displayMessage(): string {
    return this.requestId
      ? `${this.userMessage}（请求 ID：${this.requestId}）`
      : this.userMessage;
  }

  /** 会话失效（需要刷新或重新登录）。 */
  public get isAuthExpired(): boolean {
    return this.status === 401;
  }

  constructor(options: OpsApiErrorOptions) {
    super(`[ops-api] ${options.code}: ${options.userMessage}`);
    this.name = 'OpsApiError';
    this.kind = options.kind;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.userMessage = options.userMessage;
    this.retryable = options.retryable;
    this.reason = options.reason;
    this.details = options.details;
    this.raw = options.raw;
  }

  public toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      details: this.details,
      kind: this.kind,
      reason: this.reason,
      requestId: this.requestId,
      retryable: this.retryable,
      status: this.status,
      userMessage: this.userMessage,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveUserMessage(code: string, reason?: string): string {
  if (reason) {
    const byReason = REASON_MESSAGES[reason];
    if (byReason) {
      return byReason;
    }
  }
  return CODE_MESSAGES[code] ?? DEFAULT_ERROR_MESSAGE;
}

export function resolveReason(details: unknown): string | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const reason = details.reason;
  return typeof reason === 'string' && reason !== '' ? reason : undefined;
}

/** 5xx 与 429 视为服务端可恢复；4xx（含 401/403/409）一律不重试。 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export interface ParsedErrorBody {
  code?: string;
  details?: Record<string, unknown>;
  requestId?: string;
  serverMessage?: string;
}

/** 只接受契约规定的扁平体 `{code,message,requestId,details?}`，其它形态视为未知。 */
export function parseErrorBody(body: unknown): ParsedErrorBody {
  if (!isRecord(body)) {
    return {};
  }
  const parsed: ParsedErrorBody = {};
  if (typeof body.code === 'string' && body.code !== '') {
    parsed.code = body.code;
  }
  if (typeof body.requestId === 'string' && body.requestId !== '') {
    parsed.requestId = body.requestId;
  }
  if (typeof body.message === 'string' && body.message !== '') {
    parsed.serverMessage = body.message;
  }
  if (isRecord(body.details)) {
    parsed.details = body.details;
  }
  return parsed;
}

interface AxiosLikeError {
  code?: unknown;
  config?: unknown;
  message?: unknown;
  response?: {
    data?: unknown;
    headers?: Record<string, unknown> | undefined;
    status?: number;
  };
}

function isTimeoutError(error: AxiosLikeError): boolean {
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return true;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  return message.toLowerCase().includes('timeout');
}

/**
 * 把 axios 错误 / 未知异常统一收敛为 `OpsApiError`。
 *
 * 优先级：后端错误体 `requestId` > 响应头 `X-Request-Id` > 请求侧生成的 requestId。
 */
export function toOpsApiError(
  error: unknown,
  options: { requestId?: string; requestUrl?: string } = {},
): OpsApiError {
  if (error instanceof OpsApiError) {
    return error;
  }

  const isAxios = isAxiosError(error);
  if (!isAxios) {
    // 非 axios 错误（后端响应体已被上游解包、业务代码主动抛错、编程错误）：
    // 归类为未知，**不能**当成网络失败，否则会误导用户去检查网络。
    return new OpsApiError({
      code: OPS_CLIENT_ERROR_CODE.UNKNOWN,
      kind: 'unknown',
      raw: error,
      requestId: options.requestId,
      retryable: false,
      userMessage: resolveUserMessage(OPS_CLIENT_ERROR_CODE.UNKNOWN),
    });
  }

  const axiosError = error as AxiosLikeError;
  const requestIdFromConfig =
    readRequestMeta(axiosError.config).requestId ?? options.requestId;

  const response = axiosError.response;

  if (!response) {
    const timeout = isTimeoutError(axiosError);
    const code = timeout
      ? OPS_CLIENT_ERROR_CODE.TIMEOUT
      : OPS_CLIENT_ERROR_CODE.NETWORK;
    return new OpsApiError({
      code,
      kind: timeout ? 'timeout' : 'network',
      raw: error,
      requestId: requestIdFromConfig,
      retryable: true,
      userMessage: resolveUserMessage(code),
    });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const body = parseErrorBody(response.data);
  const headerRequestId =
    response.headers?.['x-request-id'] ?? response.headers?.['X-Request-Id'];
  const requestId =
    body.requestId ??
    (typeof headerRequestId === 'string' ? headerRequestId : undefined) ??
    requestIdFromConfig;
  const reason = resolveReason(body.details);

  // 401 无 body 时也要归一到 AUTH_REQUIRED，避免上游把 401 当成普通错误。
  const code =
    body.code ??
    (status === 401 ? 'AUTH_REQUIRED' : OPS_CLIENT_ERROR_CODE.UNKNOWN);

  // 登录端点上的 401 是「凭据错误」而不是「会话过期」，提示必须区分，
  // 否则用户改错密码会看到"登录状态已失效"。
  const isLoginAttempt =
    status === 401 &&
    typeof options.requestUrl === 'string' &&
    options.requestUrl.includes('/auth/login');

  return new OpsApiError({
    code,
    details: body.details,
    kind: 'http',
    raw: error,
    reason,
    requestId,
    retryable: isRetryableStatus(status),
    status,
    userMessage: isLoginAttempt
      ? '账号或密码不正确，请重新输入'
      : resolveUserMessage(code, reason),
  });
}

/** 403 的两种「会话不可继续」语义，登录态无法靠重试恢复。 */
export type OpsSessionRejection = 'disabled' | 'no_membership';

export function classifySessionRejection(
  error: OpsApiError,
): null | OpsSessionRejection {
  if (error.status !== 403) {
    return null;
  }
  if (error.reason === 'OPS_MEMBER_MISSING') {
    return 'no_membership';
  }
  if (error.reason === 'OPS_MEMBER_INACTIVE') {
    return 'disabled';
  }
  return null;
}

/**
 * 结构化日志：开发态全量，生产态只记 5xx 与服务端错误码，
 * 便于用 requestId 与后端日志对账，且不打印任何凭据。
 */
export function logOpsApiError(error: OpsApiError): void {
  const shouldLog =
    import.meta.env.DEV ||
    (error.status !== undefined && error.status >= 500) ||
    error.kind === 'network';
  if (!shouldLog) {
    return;
  }
  const level =
    error.status !== undefined && error.status >= 500 ? 'error' : 'warn';

  console[level]('ops api error', error.toJSON());
}
