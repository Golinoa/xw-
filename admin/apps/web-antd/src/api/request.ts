/**
 * 运营后台统一请求内核。
 *
 * 与上游模板的差异（逐条对应约束）：
 * 1. 成功响应是**业务 JSON 直出**（后端无 `{code:0,data}` 信封），故移除
 *    `defaultResponseInterceptor`，改为 `responseReturn: 'body'` + 直接返回 body；
 * 2. 失败统一映射为 `OpsApiError`（含 code/status/requestId/reason/可重试性），
 *    不再把状态码丢成裸响应体；
 * 3. 请求头不写 `Bearer null`；token 只从内存 store 读取（不读 localStorage、不进 URL）；
 * 4. 每次请求注入 `X-Request-Id`，重试/重放复用同一 ID；
 * 5. 401 → 单飞刷新 → 重放一次；4xx 不重试；5xx/网络失败最多重试 3 次（指数退避）。
 *
 * 业务模块只能 `import { requestClient } from '#/api/request'` 或使用 `#/api/ops/<domain>`；
 * 禁止在页面内直接使用 axios/fetch、禁止拼接 baseURL、禁止自行处理 401。
 */
import type {
  RequestClientConfig,
  ResponseInterceptorConfig,
} from '@vben/request';

import { preferences } from '@vben/preferences';
import { RequestClient } from '@vben/request';
import { useAccessStore } from '@vben/stores';

import { createAuthRefreshInterceptor } from './adapter/auth-refresh';
import { getOpsEnv } from './adapter/env';
import { logOpsApiError, toOpsApiError } from './adapter/errors';
import { notifyOpsError } from './adapter/notify';
import { resolveRequestId, writeHeader } from './adapter/request-id';
import { readRequestMeta } from './adapter/request-meta';
import { createRetryInterceptor } from './adapter/retry';

/** 模块初始化即校验环境：非法配置在应用挂载前抛错，不静默回退。 */
const opsEnv = getOpsEnv();

const AUTH_SKIP_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout'];

function formatToken(token: null | string): null | string {
  return token ? `Bearer ${token}` : null;
}

/**
 * 会话彻底失效的唯一出口。
 *
 * 采用动态 import 而非静态依赖，避免 `api/request ↔ store/auth` 的模块循环，
 * 也让本文件可以在不加载整个 store 的情况下被单测引用。
 */
async function doReAuthenticate() {
  const accessStore = useAccessStore();
  accessStore.setAccessToken(null);

  const { useAuthStore } = await import('#/store');
  const authStore = useAuthStore();
  authStore.markSessionExpired();

  if (
    preferences.app.loginExpiredMode === 'modal' &&
    accessStore.isAccessChecked
  ) {
    accessStore.setLoginExpired(true);
    return;
  }

  try {
    await authStore.logout();
  } catch (error) {
    // 跳转失败（例如路由守卫抛错）不能反向掩盖原始的 401 错误
    console.warn('ops re-authenticate redirect failed', error);
  }
}

/**
 * 刷新 access token。
 *
 * 刷新令牌在 HttpOnly Cookie 里，`withCredentials` 由 raw client 保证；
 * 端点、成败语义见 `#/api/core/auth`。
 */
async function doRefreshToken(): Promise<string> {
  const { refreshTokenApi } = await import('./core/auth');
  const result = await refreshTokenApi();
  useAccessStore().setAccessToken(result.accessToken);
  return result.accessToken;
}

/** 成功响应直出 body；显式 `responseReturn: 'raw'`（如下载）保持原样。 */
const unwrapBodyInterceptor: ResponseInterceptorConfig = {
  fulfilled: (response) => {
    if (response.config?.responseReturn === 'raw') {
      return response;
    }
    return response.data;
  },
};

/** 统一错误映射：结构化 + 记日志 + 单点提示。 */
const mapErrorInterceptor: ResponseInterceptorConfig = {
  rejected: (error: unknown) => {
    const config = (error as { config?: RequestClientConfig })?.config;
    const meta = readRequestMeta(config);
    const opsError = toOpsApiError(error, { requestUrl: config?.url });
    logOpsApiError(opsError);

    // 401 由「登录已过期」弹框/跳转统一呈现；登录端点（skipAuthRefresh）的错误
    // 由登录页内联呈现（`views/_core/authentication/login-error.ts`），都不要再弹 toast。
    const suppressNotice =
      opsError.status === 401 ||
      meta.skipAuthRefresh === true ||
      meta.suppressErrorNotice === true;
    if (!suppressNotice) {
      notifyOpsError(opsError);
    }
    return Promise.reject(opsError);
  },
};

function createRequestClient(baseURL: string) {
  const client = new RequestClient({
    baseURL,
    responseReturn: 'body',
    withCredentials: true,
  });

  // 1. 请求头：内存 token + 语言 + requestId
  client.addRequestInterceptor({
    fulfilled: (config) => {
      const accessStore = useAccessStore();
      const authorization = formatToken(accessStore.accessToken);
      if (authorization) {
        writeHeader(config.headers, 'Authorization', authorization);
      }
      resolveRequestId(config);
      writeHeader(config.headers, 'Accept-Language', preferences.app.locale);
      return config;
    },
  });

  // 2. 成功：去掉信封假设，直出业务 body
  client.addResponseInterceptor(unwrapBodyInterceptor);

  // 3. 401：单飞刷新 + 重放一次（登录/刷新/登出端点除外）
  client.addResponseInterceptor(
    createAuthRefreshInterceptor({
      client,
      formatToken,
      onSessionExpired: doReAuthenticate,
      refreshToken: doRefreshToken,
      skipPaths: AUTH_SKIP_PATHS,
    }),
  );

  // 4. 5xx/网络失败：指数退避重试（4xx 不重试）
  client.addResponseInterceptor(createRetryInterceptor(client));

  // 5. 错误映射：任何异常都收敛为 OpsApiError
  client.addResponseInterceptor(mapErrorInterceptor);

  return client;
}

export const requestClient = createRequestClient(opsEnv.apiBaseUrl);

/**
 * 无拦截器的原始客户端。
 *
 * 只用于「不依赖 access token、但需要看真实 HTTP 状态」的场景：
 * 刷新令牌、登出（Cookie 携带），以及健康检查探针。
 * 业务请求禁止使用它。
 */
export const baseRequestClient = new RequestClient({
  baseURL: opsEnv.apiBaseUrl,
  responseReturn: 'raw',
  withCredentials: true,
});

export { formatToken };
