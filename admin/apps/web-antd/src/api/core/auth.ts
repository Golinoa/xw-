/**
 * 会话凭据端点（登录 / 刷新 / 登出）。
 *
 * 安全约定（设计文档 §2.1.8）：
 * - access token 只写内存 Pinia（`useAccessStore`），不落 localStorage、不进 URL；
 * - 刷新令牌是 HttpOnly Cookie，前端只负责 `withCredentials`，JS 读不到也拿不到；
 * - 刷新与登出使用**无拦截器**的 raw client，避免 401 刷新自我递归。
 *
 * 契约缺口（已在 journal 登记待后端确认）：
 * 契约 §5 未定义认证端点，当前路径取自设计文档 §2.2 的 `/ops/auth/*`；
 * 刷新响应体假定为 `{ accessToken }` 并通过 `Set-Cookie` 轮换刷新令牌。
 */
import type { OpsLoginResult } from '#/api/ops/identity/session';

import { withRequestMeta } from '#/api/adapter/request-meta';
// 端点清单在 identity/endpoints（2026-10-30 从 session.ts 抽出）。
// 直接指文件而非 `identity/index`，避免把 members/roles 客户端一并拉进登录路径。
import { OPS_ENDPOINTS } from '#/api/ops/identity/endpoints';
import { baseRequestClient, requestClient } from '#/api/request';

export namespace AuthApi {
  /** 登录参数：运营后台以邮箱登录，不提供注册与第三方登录 [PRD §4.1]。 */
  export interface LoginParams {
    password: string;
    username: string;
  }

  export type LoginResult = OpsLoginResult;

  /** 刷新结果：只回 access token，刷新令牌在 Cookie 中轮换。 */
  export type RefreshTokenResult = OpsLoginResult;
}

/**
 * 登录。
 *
 * `__skipAuthRefresh`：登录 401 是"凭据错误"，不是"会话过期"，
 * 不能触发刷新/登出链路，否则错误提示会变成"登录已过期"。
 */
export async function loginApi(
  data: AuthApi.LoginParams,
): Promise<AuthApi.LoginResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubOpsLogin } = await import('#/api/ops/__stub__');
    return stubOpsLogin(data);
  }
  return requestClient.post<AuthApi.LoginResult>(
    OPS_ENDPOINTS.login,
    data,
    withRequestMeta({}, { skipAuthRefresh: true }),
  );
}

/**
 * 刷新 access token。
 *
 * 用 raw client 直连：需要拿到真实 HTTP 状态来区分「凭据失效」与「网络失败」，
 * 前者清会话，后者不得登出（设计文档 §2.1.6）。
 */
export async function refreshTokenApi(): Promise<AuthApi.RefreshTokenResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubOpsRefresh } = await import('#/api/ops/__stub__');
    return stubOpsRefresh();
  }
  const response =
    await baseRequestClient.instance.post<AuthApi.RefreshTokenResult>(
      OPS_ENDPOINTS.refresh,
      null,
      { withCredentials: true },
    );
  return response.data;
}

/** 登出：服务端清 HttpOnly Cookie；本地清理由 `useAuthStore.logout` 负责。 */
export async function logoutApi(): Promise<void> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubOpsLogout } = await import('#/api/ops/__stub__');
    return stubOpsLogout();
  }
  await baseRequestClient.instance.post(OPS_ENDPOINTS.logout, null, {
    withCredentials: true,
  });
}
