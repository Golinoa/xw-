import {
  apiErrorBodySchema,
  JSON_MEDIA_TYPE,
  ORGANIZATION_HEADER,
  ROUTES,
  type PathParamNames,
  type RouteKey,
  type RoutePath,
  type RouteResponse,
} from '@erp/contracts';

/** 服务端错误码 → 用户可读文案。前端不解析后端 message，只按稳定 code 映射。 */
const ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: '登录状态已失效，请重新登录',
  FORBIDDEN: '当前账号无权执行该操作',
  TENANT_SCOPE_DENIED: '没有该公司的数据权限',
  ORG_CONTEXT_REQUIRED: '请先选择公司',
  VALIDATION_ERROR: '提交的内容不合法，请检查后重试',
  NOT_FOUND: '记录不存在或已被删除',
  CONFLICT: '数据已存在或状态冲突，请刷新后重试',
  OBJECT_REFERENCED: '该记录仍被其他单据引用，不能删除',
  ORDER_STATE_CONFLICT: '当前订单状态不允许该操作，请刷新后重试',
  ORDER_LINE_HAS_PAYMENTS: '该金额行已有确认或在途款项，不能删除',
  ORDER_LINE_AMOUNT_CONFLICT: '金额不能低于该行已确认与在途的款项',
  FINANCE_AMOUNT_EXCEEDS_AVAILABLE: '申请金额超过该行的可申请余额（已扣除在途）',
  FINANCE_APPLICATION_STATE_CONFLICT: '该申请已被处理，请刷新后再看',
  FINANCE_SELF_APPROVAL_FORBIDDEN: '不能审批自己提交的申请',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
};

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** 前后端字段不一致时抛出：属于开发期缺陷，不是用户错误。 */
export class ContractViolationError extends Error {
  constructor(
    readonly route: RouteKey,
    readonly direction: 'request' | 'response',
    readonly issues: { path: string; code: string }[],
  ) {
    super(`契约不一致：${route} 的${direction === 'request' ? '请求' : '响应'}字段与契约不符`);
    this.name = 'ContractViolationError';
  }
}

export interface ApiClientOptions {
  /** 留空表示同源部署（Worker 同时托管前端与 API）。 */
  baseUrl?: string;
  getAccessToken: () => string | null | Promise<string | null>;
  getOrganizationId?: () => string | null;
  fetcher?: typeof fetch;
  /** 5xx 自动重试次数，4xx 不重试。 */
  maxServerErrorRetries?: number;
  retryDelayMs?: number;
}

export interface CallOptions<K extends RouteKey> {
  params?: Record<PathParamNames<RoutePath<K>>, string>;
  /**
   * 请求体。GET 路由的契约 `request` 描述的是查询条件，此时 body 经校验后
   * 序列化为查询串（见 `toQueryString`），不会作为请求体发出。
   */
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * 查询串的值来自已通过契约校验的对象，因此这里只做序列化，不再重复校验。
 * 空值不写入 URL，避免 `?keyword=` 这类无意义参数影响缓存与分享。
 */
function toQueryString(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  const search = new URLSearchParams();
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined || raw === null || raw === '') continue;
    search.append(name, String(raw));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

function describeIssues(error: { issues: { path: PropertyKey[]; code: string }[] }) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    code: issue.code,
  }));
}

function buildPath(template: string, params: Record<string, string> | undefined): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (!value) throw new Error(`缺少路径参数 ${name}（${template}）`);
    return encodeURIComponent(value);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 同一逻辑写操作在重试时必须复用同一个键，服务端才能识别为重复提交。
 * 键在单次 call 内生成一次，跨 retry 不变；不同 call 各自生成。
 */
function createIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createApiClient(options: ApiClientOptions) {
  const fetcher = options.fetcher ?? fetch;
  const maxRetries = options.maxServerErrorRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 200;

  async function call<K extends RouteKey>(
    key: K,
    callOptions: CallOptions<K> = {},
  ): Promise<RouteResponse<K>> {
    const route = ROUTES[key];
    const requestSchema = 'request' in route ? route.request : undefined;

    if (requestSchema) {
      /**
       * 契约里的 `request` 有两种用途：请求体（create/update）与路径参数（get/delete）。
       * 调用方给了 body 就校验 body，否则校验 params——没有这一步，纯路径参数路由
       * 会因为 body 为空而永远通不过自检。
       */
      const candidate = callOptions.body === undefined ? callOptions.params : callOptions.body;
      const parsed = requestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new ContractViolationError(key, 'request', describeIssues(parsed.error));
      }
    }

    const path = buildPath(route.path, callOptions.params as Record<string, string> | undefined);
    // GET 只有查询条件，没有请求体；其余方法才把 body 送到服务端。
    const sendsBody = route.method !== 'GET';
    const query = route.method === 'GET' ? toQueryString(callOptions.body) : '';
    const url = `${options.baseUrl ?? ''}${path}${query}`;
    let token = await options.getAccessToken();
    if (!token) throw new ApiClientError('AUTH_REQUIRED', ERROR_MESSAGES.AUTH_REQUIRED!, 401);

    const idempotencyKey = route.method === 'GET' ? undefined : createIdempotencyKey();

    const send = async (bearer: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
      const organizationId = options.getOrganizationId?.() ?? null;
      if (organizationId) headers[ORGANIZATION_HEADER] = organizationId;
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      if (callOptions.body !== undefined && sendsBody) headers['Content-Type'] = JSON_MEDIA_TYPE;
      return fetcher(url, {
        method: route.method,
        headers,
        ...(callOptions.body === undefined || !sendsBody
          ? {}
          : { body: JSON.stringify(callOptions.body) }),
        ...(callOptions.signal ? { signal: callOptions.signal } : {}),
      });
    };

    let response = await send(token);
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      // 401：让上层重新取一次令牌（Supabase 客户端会顺带刷新），同一请求只重试一次。
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        const next = await options.getAccessToken();
        if (next && next !== token) {
          token = next;
          response = await send(token);
          continue;
        }
      }
      // 5xx / 网络错误：可重试；4xx 一律不重试。
      if (response.status >= 500 && attempt < maxRetries) {
        attempt += 1;
        await sleep(retryDelayMs * attempt);
        response = await send(token);
        continue;
      }
      break;
    }

    if (response.status === 204) return undefined as RouteResponse<K>;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiClientError(
        'INTERNAL_ERROR',
        response.ok ? '服务返回了无法解析的内容' : ERROR_MESSAGES.INTERNAL_ERROR!,
        response.status,
      );
    }

    if (!response.ok) {
      const parsedError = apiErrorBodySchema.safeParse(payload);
      if (parsedError.success) {
        const { code, message, requestId } = parsedError.data;
        throw new ApiClientError(code, ERROR_MESSAGES[code] ?? message, response.status, requestId);
      }
      throw new ApiClientError('INTERNAL_ERROR', ERROR_MESSAGES.INTERNAL_ERROR!, response.status);
    }

    const parsed = route.response.safeParse(payload);
    if (!parsed.success) {
      throw new ContractViolationError(key, 'response', describeIssues(parsed.error));
    }
    return parsed.data as RouteResponse<K>;
  }

  return { call };
}

export type ApiClient = ReturnType<typeof createApiClient>;
