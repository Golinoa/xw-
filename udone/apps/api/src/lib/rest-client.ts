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
  /** Supabase Auth call. Returns the raw Response so callers keep their status branches. */
  auth(path: string, init?: AuthInit): Promise<Response>;
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

  return {
    async rest<T>(path: string, init: RestInit = {}): Promise<T> {
      requireConfig();
      const headers: Record<string, string> = {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      new Headers(init.headers).forEach((value, name) => {
        headers[name] = value;
      });
      if (init.organizationId) headers['X-Organization-ID'] = init.organizationId;

      const response = await fetch(`${base}/rest/v1/${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        if (response.status === 409 || isUniqueViolation(payload)) {
          throw new RestConflictError();
        }
        throw new RestRequestError(response.status, `Supabase request failed (${response.status})`);
      }

      if (response.status === 204) return undefined as T;
      return response.json() as Promise<T>;
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
