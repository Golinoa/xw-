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

function isUniqueViolation(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { code?: unknown }).code === '23505'
  );
}

/**
 * Single HTTP exit for Supabase. Every repository and service goes through here so
 * auth headers, organisation scoping and error mapping cannot drift per module.
 */
export function createRestClient(
  environment: ApiEnvironment['Bindings'],
  token: string,
): RestClient {
  const base = (environment.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const publishableKey = environment.SUPABASE_PUBLISHABLE_KEY ?? '';

  function requireConfig() {
    if (!base || !publishableKey) {
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
    const headers: Record<string, string> = {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    Object.assign(headers, extraHeaders);
    if (init.organizationId) headers['X-Organization-ID'] = init.organizationId;

    const response = await fetch(`${base}/rest/v1/${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    if (!response.ok && !allowedStatuses.includes(response.status)) {
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409 || isUniqueViolation(payload)) {
        throw new RestConflictError();
      }
      throw new RestRequestError(response.status, `Supabase request failed (${response.status})`);
    }

    return response;
  }

  return {
    async rest<T>(path: string, init: RestInit = {}): Promise<T> {
      const response = await restFetch(path, init);
      if (response.status === 204) return undefined as T;
      return response.json() as Promise<T>;
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
