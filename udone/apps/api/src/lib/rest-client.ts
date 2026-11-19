import { ERROR_CODES } from '@erp/contracts';
import type { ApiEnvironment } from '../middleware/auth';
import { ApiHttpError } from '../middleware/error-handler';

/** Non-2xx PostgREST response. The upstream body is never echoed to the caller. */
export class RestRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RestRequestError';
  }
}

/**
 * 目标资源不存在：PostgREST 回 404（表/视图没建）或 PGRST202（RPC 没建）。
 *
 * 这类错误几乎总是「迁移没应用」或「代码引用了不存在的函数」，属于部署问题。
 * 不单独区分的话会落到通用的 500「服务暂时不可用」，排查时完全看不出缺的是什么，
 * 只能一个个人工比对迁移清单。
 */
export class RestMissingResourceError extends RestRequestError {
  constructor(readonly resource: string) {
    super(404, `Supabase resource missing: ${resource}`);
    this.name = 'RestMissingResourceError';
  }
}

/** A unique-constraint violation, reported either as 409 or as Postgres code 23505. */
export class RestConflictError extends RestRequestError {
  constructor(message = 'Resource conflict') {
    super(409, message);
    this.name = 'RestConflictError';
  }
}

export interface RestInit {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  organizationId?: string;
  /**
   * PostgREST schema profile，默认 schema 不需要传。
   *
   * PostgREST 用两个不同的头区分「读哪个 schema」与「写进哪个 schema」：
   * `Accept-Profile` 管 GET/HEAD/DELETE 的读取，`Content-Profile` 管写方法。
   * 只发一个的话，跨 schema 的写会落到 public、读会报「表不存在」，
   * 两种失败看起来都跟 schema 无关。
   */
  profile?: string;
}

export interface RestClientOptions {
  /**
   * 覆盖 `apikey` 头。
   *
   * service_role 调用必须让 `apikey` 与 `Authorization` 是同一个 service_role
   * 令牌：PostgREST 先按 apikey 决定请求是否合法，再按 Authorization 决定
   * 执行角色，两者不一致时会以 401 或 anon 身份执行，而 anon 什么都没有。
   */
  apiKey?: string;
}

export interface AuthInit {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  apiKey?: string;
  bearer?: string;
}

export interface RestClient {
  /** PostgREST call. Throws RestRequestError/RestConflictError on a non-2xx response. */
  rest<T>(path: string, init?: RestInit): Promise<T>;
  /**
   * PostgREST call with `Prefer: count=exact`. The total comes from `Content-Range`
   * because PostgREST does not put the count in the body — a list endpoint that needs
   * `total` cannot derive it from the rows it happens to receive.
   */
  restPage<T>(path: string, init?: RestInit): Promise<RestPage<T>>;
  /** Supabase Auth call. Returns the raw Response so callers keep their status branches. */
  auth(path: string, init?: AuthInit): Promise<Response>;
}

export interface RestPage<T> {
  rows: T[];
  /** Total matching rows across all pages, not the size of `rows`. */
  total: number;
}

/** `Content-Range: 0-14/123`, or `*&#47;0` when the filter matches nothing. */
function parseContentRange(value: string | null): number {
  if (!value) return 0;
  const total = value.split('/')[1];
  if (!total || total === '*') return 0;
  const parsed = Number.parseInt(total, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** PostgREST 找不到函数/表时给的 code：PGRST202 = 函数不存在，PGRST205 = 表不在 schema 缓存里。 */
function isMissingResource(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const code = (payload as { code?: unknown }).code;
  return code === 'PGRST202' || code === 'PGRST205';
}

function isUniqueViolation(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { code?: unknown }).code === '23505'
  );
}

const READ_METHODS = new Set(['GET', 'HEAD']);
const DELETE_METHOD = 'DELETE';

/**
 * PostgREST 的 profile 头。DELETE 同时要两个：它既读也写。
 *
 * 不设 profile 时必须完全不发这些头——PostgREST 在没有任何 profile 头时
 * 用配置里的第一个 schema，这是现有 31 个端点依赖的行为。
 */
function profileHeaders(method: string, profile: string | undefined): Record<string, string> {
  if (!profile) return {};
  const normalized = method.toUpperCase();
  const headers: Record<string, string> = {};
  if (READ_METHODS.has(normalized) || normalized === DELETE_METHOD) {
    headers['Accept-Profile'] = profile;
  }
  if (!READ_METHODS.has(normalized)) {
    headers['Content-Profile'] = profile;
  }
  return headers;
}

/**
 * Single HTTP exit for Supabase. Every repository and service goes through here so
 * auth headers, organisation scoping and error mapping cannot drift per module.
 */
export function createRestClient(
  environment: ApiEnvironment['Bindings'],
  token: string,
  options: RestClientOptions = {},
): RestClient {
  const base = (environment.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const publishableKey = environment.SUPABASE_PUBLISHABLE_KEY ?? '';
  const apiKey = options.apiKey ?? publishableKey;

  function requireConfig() {
    if (!base || !apiKey) {
      throw new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'Supabase is not configured');
    }
  }

  async function restFetch(
    path: string,
    init: RestInit,
    extraHeaders: Record<string, string> = {},
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    requireConfig();
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      apikey: apiKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...profileHeaders(method, init.profile),
    };
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    Object.assign(headers, extraHeaders);
    if (init.organizationId) headers['X-Organization-ID'] = init.organizationId;

    const response = await fetch(`${base}/rest/v1/${path}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    if (!response.ok && !allowedStatuses.includes(response.status)) {
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409 || isUniqueViolation(payload)) {
        throw new RestConflictError();
      }
      if (response.status === 404 || isMissingResource(payload)) {
        // path 里已经带了 `rpc/xxx` 或表名，正是排查时最需要的那一条信息。
        throw new RestMissingResourceError(path.split('?')[0] ?? path);
      }
      throw new RestRequestError(response.status, `Supabase request failed (${response.status})`);
    }

    return response;
  }

  return {
    async rest<T>(path: string, init: RestInit = {}): Promise<T> {
      const response = await restFetch(path, init);
      // 204 与「2xx 但 body 为空」是同一件事：这个调用没有返回值。
      // 只判 204 不够——`Prefer: return=minimal` 的写入是 201 + 空 body，
      // 直接 response.json() 会抛一个看起来像「上游坏了」的解析错误。
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    },

    async restPage<T>(path: string, init: RestInit = {}): Promise<RestPage<T>> {
      // 416 不是错误，是「这一页在数据范围之外」。PostgREST 在 offset 超过
      // 总行数时返回它，并仍然给出 `Content-Range: */<total>`。
      // 不特殊处理的话，用户从筛选结果翻到第 2 页就会看到 500——而正确的
      // 表现是空页 + 正确的总数，分页器才能自己退回去。
      const response = await restFetch(path, init, { Prefer: 'count=exact' }, [416]);
      const total = parseContentRange(response.headers.get('Content-Range'));
      if (response.status === 204 || response.status === 416) return { rows: [], total: total };
      const rows = (await response.json()) as T[];
      return { rows, total };
    },

    async auth(path: string, init: AuthInit = {}): Promise<Response> {
      requireConfig();
      const headers: Record<string, string> = {
        apikey: init.apiKey ?? publishableKey,
        ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      };
      new Headers(init.headers).forEach((value, name) => {
        headers[name] = value;
      });

      return fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    },
  };
}

/**
 * service_role 客户端，只给基础设施表用（幂等记录、审计落地等）。
 *
 * 业务读写绝不能用它：service_role 绕过 RLS，一旦被业务模块拿去查客户或订单，
 * 「租户隔离」这条防线会在无人察觉的情况下消失，而且测试仍然全绿——因为库函数
 * 里的 organization_id 过滤看起来还在。
 *
 * 没有配置 service_role 时直接 503，不做降级：降级成 publishable key 会让
 * 写基础设施表的请求以 anon 身份被拒，错误现场离原因很远。
 */
export function createServiceRestClient(environment: ApiEnvironment['Bindings']): RestClient {
  const key = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'Supabase service role is not configured',
    );
  }
  return createRestClient(environment, key, { apiKey: key });
}
