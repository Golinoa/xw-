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
  ORG_CONTEXT_REQUIRED: '请先选择公司',
  VALIDATION_ERROR: '提交的内容不合法，请检查后重试',
  CONFLICT: '数据已存在或状态冲突，请刷新后重试',
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
  body?: unknown;
  signal?: AbortSignal;
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
      const parsed = requestSchema.safeParse(callOptions.body);
      if (!parsed.success) {
        throw new ContractViolationError(key, 'request', describeIssues(parsed.error));
      }
    }

    const path = buildPath(route.path, callOptions.params as Record<string, string> | undefined);
    const url = `${options.baseUrl ?? ''}${path}`;
    let token = await options.getAccessToken();
    if (!token) throw new ApiClientError('AUTH_REQUIRED', ERROR_MESSAGES.AUTH_REQUIRED!, 401);

    const idempotencyKey = route.method === 'GET' ? undefined : createIdempotencyKey();

    const send = async (bearer: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
      const organizationId = options.getOrganizationId?.() ?? null;
      if (organizationId) headers[ORGANIZATION_HEADER] = organizationId;
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      if (callOptions.body !== undefined) headers['Content-Type'] = JSON_MEDIA_TYPE;
      return fetcher(url, {
        method: route.method,
        headers,
        ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
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
