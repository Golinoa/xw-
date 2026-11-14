/**
 * 401 → 刷新 → 重放一次。
 *
 * 关键约束（设计文档 §2.1.6、§2.1.8）：
 * - access token 只在内存；刷新令牌是 HttpOnly Cookie，JS 不可读；
 * - 刷新必须**单飞**：并发 401 只触发一次刷新，其余请求排队等同一个结果；
 * - 刷新返回 401/403 → 会话彻底失效 → 清会话；
 * - 刷新遇到**网络错误不得登出**，原样抛出，让页面进入可重试的错误态；
 * - 重放只做一次（`isRetryRequest`），避免 401 死循环。
 */
import type {
  RequestClient,
  RequestClientConfig,
  ResponseInterceptorConfig,
} from '@vben/request';

import { toOpsApiError } from './errors';
import { writeHeader } from './request-id';
import { readRequestMeta, writeRequestMeta } from './request-meta';

export interface AuthRefreshOptions {
  client: RequestClient;
  /** 用 Bearer 前缀格式化 token；token 为空时不写 Authorization 头。 */
  formatToken: (token: null | string) => null | string;
  /** 刷新令牌，失败时抛错（401/403 或网络错误）。 */
  refreshToken: () => Promise<string>;
  /** 会话不可恢复时的唯一出口：清理会话并提示重新登录。 */
  onSessionExpired: () => Promise<void> | void;
  /** 自身不参与刷新流程的路径（登录/刷新/登出），按后缀匹配。 */
  skipPaths?: string[];
}

function matchesSkipPath(url: string, skipPaths: string[]): boolean {
  return skipPaths.some((path) => path !== '' && url.endsWith(path));
}

export function createAuthRefreshInterceptor(
  options: AuthRefreshOptions,
): ResponseInterceptorConfig {
  const {
    client,
    formatToken,
    onSessionExpired,
    refreshToken,
    skipPaths = [],
  } = options;

  // 单飞：闭包内的 inFlight 保证同一时刻只有一个刷新请求在飞
  let inFlight: null | Promise<string> = null;

  return {
    rejected: async (error: unknown) => {
      const failure = error as {
        config?: RequestClientConfig;
        response?: { status?: number };
      };
      const config = failure.config;

      if (failure.response?.status !== 401 || !config) {
        throw error;
      }

      const meta = readRequestMeta(config);
      if (
        meta.skipAuthRefresh ||
        matchesSkipPath(config.url ?? '', skipPaths)
      ) {
        throw error;
      }
      if (meta.isRetryRequest) {
        // 刷新后仍然 401：会话不可恢复
        await onSessionExpired();
        throw error;
      }

      inFlight ??= (async () => {
        try {
          return await refreshToken();
        } finally {
          inFlight = null;
        }
      })();

      let newToken: string;
      try {
        newToken = await inFlight;
      } catch (refreshError) {
        const refreshOpsError = toOpsApiError(refreshError);
        if (
          refreshOpsError.kind === 'network' ||
          refreshOpsError.kind === 'timeout'
        ) {
          // 网络失败不等于凭据失效：不登出，交给页面重试
          throw error;
        }
        await onSessionExpired();
        throw error;
      }

      const authorization = formatToken(newToken);
      if (authorization) {
        config.headers ??= {};
        writeHeader(config.headers, 'Authorization', authorization);
      }
      writeRequestMeta(config, { isRetryRequest: true });

      return client.instance.request(config);
    },
  };
}
