import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ERROR_CODES } from '@erp/contracts';
import { idempotencyStorageKey, requestFingerprint } from '../lib/idempotency-key';
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
 *
 * 命中缓存前先比请求体指纹：同一个 key 配上不同的内容不是重试，是客户端
 * 复用了 key。此时回放旧响应会把「这一次的写入没有发生」伪装成成功——
 * 对会动钱的端点来说，这比直接报错严重得多。
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

    // 克隆再读：路由里的 parseJson() 还要读同一个请求体。
    const rawBody = await context.req.raw
      .clone()
      .text()
      .catch(() => '');
    const requestHash = await requestFingerprint(rawBody);
    const storageKey = await idempotencyStorageKey({
      authorization: context.req.header('Authorization'),
      organizationId: context.req.header('X-Organization-ID'),
      method: context.req.method,
      path: context.req.path,
      key,
    });

    const replay = await store.get(storageKey);
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new ApiHttpError(
          409,
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          'This Idempotency-Key was already used for a different request',
        );
      }
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

    await store.set(storageKey, { status, body, requestHash });
  };
}
