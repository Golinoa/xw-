import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ERROR_CODES } from '@erp/contracts';
import { idempotencyStorageKey, requestFingerprint, resolveCaller } from '../lib/idempotency-key';
import { createMemoryIdempotencyStore, type IdempotencyStore } from '../lib/idempotency-store';
import { createOpsIdempotencyStore } from '../lib/ops-idempotency-store';
import { createServiceRestClient } from '../lib/rest-client';
import type { ApiEnvironment } from './auth';
import { ApiHttpError } from './error-handler';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface IdempotencyOptions {
  store?: IdempotencyStore;
}

/** 只有本 isolate 有效；见 idempotency-store.ts 的说明。 */
const defaultStore = createMemoryIdempotencyStore();

/** 降级只提示一次，否则每个写请求都会刷一行日志把真问题淹掉。 */
let warnedAboutMemoryStore = false;

/**
 * 没有 `SUPABASE_JWT_SECRET` 时的告警开关。
 *
 * 这个降级比内存 store 那条更隐蔽：它不会让任何东西报错，只会让幂等在一个
 * 看起来完全正常的环境里失效——access token 刷新后重试会被当成新请求。
 * 所以它必须至少在日志里说一次，否则「生产忘了配」这件事只能靠事故发现。
 */
let warnedAboutTokenHashFallback = false;

/**
 * 选了哪个 store。
 *
 * 配了 service_role 就用落库的，否则退回内存并显式警告一次。这个降级是刻意的：
 * 本地开发与单测没有 service_role，不该因此跑不起来；生产没有配就等于
 * 「幂等只在单个 isolate 内有效」，必须在日志里说得清清楚楚。
 *
 * 这里不吞异常：幂等表读不到时让请求直接失败，而不是悄悄退回内存再假装成功。
 * 业务写入本来就依赖同一个 PostgREST，它不可用时写入也成功不了；把「幂等失效
 * 但写入成功」这种半好状态藏起来，比报错危险。
 */
function resolveStore(context: Context<ApiEnvironment>): IdempotencyStore {
  if (!context.env?.SUPABASE_SERVICE_ROLE_KEY) {
    if (!warnedAboutMemoryStore) {
      warnedAboutMemoryStore = true;
      console.warn(
        JSON.stringify({
          event: 'idempotency_store_degraded',
          reason: 'SUPABASE_SERVICE_ROLE_KEY is not configured',
          effect: 'replays are only deduplicated within this worker isolate',
        }),
      );
    }
    return defaultStore;
  }
  return createOpsIdempotencyStore({ client: createServiceRestClient(context.env) });
}

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

    const store = options.store ?? resolveStore(context);

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
    // 调用者分量取自验签后的 sub：令牌在两次重试之间刷新时，哈希会变而 sub 不变。
    // `context.env` 在 `app.request()` 未传 env 时是 undefined（单测就是这样跑的），
    // 直接取属性会抛 TypeError 并被 errorHandler 变成 500——现象是处理函数一次都没执行。
    const authorization = context.req.header('Authorization');
    const jwtSecret = context.env?.SUPABASE_JWT_SECRET;
    if (!jwtSecret && authorization && !warnedAboutTokenHashFallback) {
      warnedAboutTokenHashFallback = true;
      console.warn(
        JSON.stringify({
          event: 'idempotency_scope_degraded',
          reason: 'SUPABASE_JWT_SECRET is not configured',
          effect:
            'the caller dimension falls back to hashing the token, so a retry ' +
            'across a token refresh will not be recognised as the same request',
        }),
      );
    }
    const caller = await resolveCaller(authorization, jwtSecret);
    const storageKey = idempotencyStorageKey({
      caller: caller.storageKey,
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

    await store.set(storageKey, { status, body, requestHash, actorId: caller.subject });
  };
}
