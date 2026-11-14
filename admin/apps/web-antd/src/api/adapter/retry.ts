/**
 * 失败重试。
 *
 * 契约要求（设计文档 §2.1.5、任务书）：4xx 不重试；5xx 最多重试 3 次且指数退避。
 *
 * 额外安全规则：只对**幂等方法**（GET/HEAD/OPTIONS）或携带 `Idempotency-Key` 的请求重试。
 * 原因：`POST /receipts` 之类写操作若没有幂等键，重试可能造成重复登记；后端要求写操作带
 * `Idempotency-Key`（契约 §2.5），带键时才允许重放。
 */
import type {
  RequestClient,
  RequestClientConfig,
  ResponseInterceptorConfig,
} from '@vben/request';

import { readHeader } from './request-id';
import { readRequestMeta, writeRequestMeta } from './request-meta';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export interface OpsRetryPolicy {
  /** 最大重试次数（不含首次请求）。 */
  maxRetries: number;
  /** 首次退避毫秒数，之后按 2 的幂递增。 */
  baseDelayMs: number;
}

export const DEFAULT_OPS_RETRY_POLICY: OpsRetryPolicy = {
  baseDelayMs: 300,
  maxRetries: 3,
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableFailure(status: number | undefined): boolean {
  if (status === undefined) {
    // 无响应 = 网络失败/超时
    return true;
  }
  return status >= 500 || status === 429;
}

function isRetryableRequest(config: RequestClientConfig): boolean {
  const method = (config.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return true;
  }
  return (readHeader(config.headers, IDEMPOTENCY_KEY_HEADER) ?? '') !== '';
}

/** 退避序列：base, base*2, base*4 …（确定性，无抖动，便于测试与复现）。 */
export function retryDelayMs(attempt: number, policy: OpsRetryPolicy): number {
  return policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
}

export function createRetryInterceptor(
  client: RequestClient,
  policy: OpsRetryPolicy = DEFAULT_OPS_RETRY_POLICY,
): ResponseInterceptorConfig {
  return {
    rejected: async (error: unknown) => {
      const failure = error as {
        config?: RequestClientConfig;
        response?: { status?: number };
      };
      const config = failure.config;

      if (!config) {
        throw error;
      }
      const meta = readRequestMeta(config);
      if (meta.skipRetry || !isRetryableFailure(failure.response?.status)) {
        throw error;
      }
      if (!isRetryableRequest(config)) {
        throw error;
      }

      const attempt = (meta.retryCount ?? 0) + 1;
      if (attempt > policy.maxRetries) {
        throw error;
      }
      writeRequestMeta(config, { retryCount: attempt });

      await sleep(retryDelayMs(attempt, policy));
      return client.instance.request(config);
    },
  };
}
