import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ERROR_CODES } from '@erp/contracts';
import { createMemoryIdempotencyStore, type IdempotencyStore } from '../lib/idempotency-store';
import type { ApiEnvironment } from './auth';
import { ApiHttpError } from './error-handler';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface IdempotencyOptions {
  store?: IdempotencyStore;
}

/** Shared across requests in this isolate; see the store for the multi-instance caveat. */
const defaultStore = createMemoryIdempotencyStore();

/**
 * Replays a previously committed response for a repeated write request.
 *
 * Only 2xx JSON responses are cached: a failed request must stay retryable, and a
 * replayed error would hide a transient failure the caller could recover from.
 */
export function idempotency(options: IdempotencyOptions = {}): MiddlewareHandler<ApiEnvironment> {
  const store = options.store ?? defaultStore;

  return async (context, next) => {
    if (!WRITE_METHODS.has(context.req.method)) {
      await next();
      return;
    }

    const key = context.req.header('Idempotency-Key');
    if (!key) {
      await next();
      return;
    }

    if (!KEY_PATTERN.test(key)) {
      throw new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'Idempotency-Key must be 8-128 characters of A-Z, a-z, 0-9, underscore or hyphen',
      );
    }

    const replay = await store.get(key);
    if (replay) {
      context.header('Idempotent-Replay', 'true');
      return context.json(
        replay.body as Record<string, unknown>,
        replay.status as ContentfulStatusCode,
      );
    }

    await next();

    const status = context.res.status;
    if (status < 200 || status >= 300) return;

    const body: unknown = await context.res
      .clone()
      .json()
      .catch(() => null);
    if (body === null) return;

    await store.set(key, { status, body });
  };
}
