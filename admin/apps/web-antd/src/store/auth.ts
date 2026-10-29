/**
 * 运营后台会话状态机。
 *
 * 状态落点（每个状态都必须有明确去向，不允许"什么都没发生"）：
 *
 * | 状态 | 触发 | 界面落点 |
 * |---|---|---|
 * | `authenticating` | 提交登录 | 按钮 loading |
 * | `authenticated` | 拿到 token 且权限码非空 | 跳 `homePath` / `redirect` |
 * | `no_permission` | 登录成功但权限码为空 | 视为失败：清会话 + 登录页内联「无运营权限」 |
 * | `no_membership` | 403 `OPS_MEMBER_MISSING` | 清会话 + 登录页内联提示 |
 * | `disabled` | 403 `OPS_MEMBER_INACTIVE` | 清会话 + 登录页内联提示 |
 * | `failed` | 401 凭据错误 / 其它 4xx | 清会话 + 登录页内联提示，可重试 |
 * | `network_error` | 无响应 / 超时 | 可重试，保留已填内容（不清表） |
 * | `expired` | 页面内 401 且刷新失败 | 清会话 → 弹重登框或跳登录 |
 * | `idle` | 主动登出 / 未登录 | 登录页 |
 */
import type { Recordable } from '@vben/types';

import type { OpsUserInfo } from '#/api/core/user';
import type { ContractCompatibility } from '#/api/ops/identity';

import { ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';
import { preferences } from '@vben/preferences';
import { resetAllStores, useAccessStore, useUserStore } from '@vben/stores';

import { notification } from 'ant-design-vue';
import { defineStore } from 'pinia';

import { getUserInfoApi, loginApi, logoutApi } from '#/api';
import {
  classifySessionRejection,
  OpsApiError,
  toOpsApiError,
} from '#/api/adapter/errors';
import { checkContractCompatibility, fetchOpsMeta } from '#/api/ops/identity';
import { $t } from '#/locales';

/** 会话状态。与设计文档 §2.2 的状态表一一对应。 */
export type OpsSessionState =
  | 'authenticated'
  | 'authenticating'
  | 'contract_mismatch'
  | 'disabled'
  | 'expired'
  | 'failed'
  | 'idle'
  | 'network_error'
  | 'no_membership'
  | 'no_permission';

export interface AuthLoginSuccess {
  userInfo: OpsUserInfo;
}

/**
 * 读取 `/meta` 并判定契约版本。
 *
 * 只在登录成功后调用一次：版本在运行期不会变，每次进页都请求只会增加延迟。
 * 网络失败会向上抛并由 `authLogin` 的 catch 归类为 `network_error`，刻意不在
 * 此吞掉——否则「取不到版本」会被伪装成「版本不兼容」，两种问题的处理方式
 * 完全不同（前者重试，后者要升级前端或后端）。
 */
async function readContractVerdict(): Promise<ContractCompatibility> {
  const meta = await fetchOpsMeta();
  return checkContractCompatibility(meta.contractVersion);
}

function resolveFailureState(error: OpsApiError): OpsSessionState {
  const rejection = classifySessionRejection(error);
  if (rejection) {
    return rejection;
  }
  if (error.kind === 'network' || error.kind === 'timeout') {
    return 'network_error';
  }
  return 'failed';
}

export const useAuthStore = defineStore('auth', () => {
  const accessStore = useAccessStore();
  const userStore = useUserStore();
  const router = useRouter();

  const loginLoading = ref(false);
  const sessionState = ref<OpsSessionState>('idle');
  const lastSessionError = shallowRef<null | OpsApiError>(null);

  /** 本地清会话：内存 token、用户信息、权限码、访问检查标记。 */
  function clearLocalSession() {
    resetAllStores();
    accessStore.setAccessToken(null);
    accessStore.setAccessCodes([]);
    accessStore.setLoginExpired(false);
    userStore.setUserInfo(null);
  }

  /**
   * 异步处理登录。
   *
   * 失败时**抛出** `OpsApiError`：登录页在 `handleSubmit` 中按错误码渲染内联提示
   * （`views/_core/authentication/login-error.ts`），因此这里不吞异常、也不弹全局 toast。
   * 任何失败都会清掉半截会话，避免"有 token 但没有用户信息"的中间态。
   */
  async function authLogin(
    params: Recordable<any>,
    onSuccess?: () => Promise<void> | void,
  ): Promise<AuthLoginSuccess> {
    loginLoading.value = true;
    sessionState.value = 'authenticating';
    lastSessionError.value = null;
    // 已认证但零动作码不是 HTTP 失败，需要在 catch 里保留专属状态
    let zeroPermission = false;
    // 契约版本不兼容同样不是 HTTP 失败，需要独立状态供登录页给出升级提示
    let contractMismatch = false;

    try {
      const { accessToken } = await loginApi({
        password: String(params?.password ?? ''),
        username: String(params?.username ?? ''),
      });

      if (!accessToken) {
        throw new OpsApiError({
          code: 'INTERNAL_ERROR',
          kind: 'unknown',
          retryable: false,
          userMessage: '登录响应异常：缺少 accessToken（前后端契约不匹配）',
        });
      }
      accessStore.setAccessToken(accessToken);

      // 用户信息与会话校验合并为一次 `/session` 请求（契约 §5.1）
      const userInfo = await fetchUserInfo();

      // 契约版本门（契约 §2.1、§8）：`/meta` 自述版本与前端锁定的版本必须
      // MAJOR 相同，否则拒绝渲染业务页。刻意放在登录成功之后——登录页本身
      // 不受阻断，否则运维连「版本不匹配」这条提示都看不到，只能看白屏。
      const verdict = await readContractVerdict();
      if (!verdict.compatible) {
        contractMismatch = true;
        throw new OpsApiError({
          code: 'CONTRACT_VERSION_MISMATCH',
          details: {
            actual: verdict.actual,
            expected: verdict.expected,
            reason: verdict.reason,
          },
          kind: 'http',
          retryable: false,
          userMessage: `契约版本不兼容：后端 ${verdict.actual}，前端 ${verdict.expected}（${verdict.reason}）`,
        });
      }

      if (userInfo.accessCodes.length === 0) {
        // 已认证但没有任何动作码：没有任何页面可访问，按失败处理并清会话。
        // 无权限页由路由负责人在静态路由里补，前端这里只给出可归类的错误。
        zeroPermission = true;
        throw new OpsApiError({
          code: 'FORBIDDEN',
          kind: 'http',
          retryable: false,
          userMessage: '当前账号没有任何运营权限动作，请联系管理员分配角色',
        });
      }

      sessionState.value = 'authenticated';

      if (accessStore.loginExpired) {
        accessStore.setLoginExpired(false);
      } else if (onSuccess) {
        await onSuccess();
      } else {
        await router.push(userInfo.homePath || preferences.app.defaultHomePath);
      }

      if (userInfo.realName) {
        notification.success({
          description: `${$t('authentication.loginSuccessDesc')}:${userInfo.realName}`,
          duration: 3,
          message: $t('authentication.loginSuccess'),
        });
      }

      return { userInfo };
    } catch (error) {
      const opsError = toOpsApiError(error);
      accessStore.setAccessToken(null);
      accessStore.setAccessCodes([]);
      userStore.setUserInfo(null);
      // 版本不兼容优先于零权限：前者即使有权限也进不去，报「无权限」会误导运维
      if (contractMismatch) {
        sessionState.value = 'contract_mismatch';
      } else {
        sessionState.value = zeroPermission
          ? 'no_permission'
          : resolveFailureState(opsError);
      }
      lastSessionError.value = opsError;
      throw opsError;
    } finally {
      loginLoading.value = false;
    }
  }

  /**
   * 主动登出。
   *
   * 必须清理动态路由：模板只 `resetAllStores()`，导致下一个账号沿用上一个账号的
   * 路由表（跨账号泄漏，设计文档 §1.4）。`resetRoutes()` 在 `src/router` 中导出，
   * 用动态 import 避免 `router → store → router` 的初始化循环。
   */
  async function logout(redirect: boolean = true) {
    try {
      await logoutApi();
    } catch (error) {
      // 服务端清 Cookie 失败不应阻塞本地登出，但要留痕便于排查
      console.warn('ops logout failed', toOpsApiError(error).toJSON());
    }

    clearLocalSession();
    sessionState.value = 'idle';
    lastSessionError.value = null;

    const { resetRoutes } = await import('#/router');
    resetRoutes();

    await router.replace({
      path: LOGIN_PATH,
      query: redirect
        ? {
            redirect: encodeURIComponent(router.currentRoute.value.fullPath),
          }
        : {},
    });
  }

  /** 拉取当前运营用户信息；同时回填权限码（路由/按钮三层呈现的唯一来源）。 */
  async function fetchUserInfo(): Promise<OpsUserInfo> {
    const userInfo = await getUserInfoApi();
    userStore.setUserInfo({
      ...userInfo,
      avatar: userInfo.avatar ?? preferences.app.defaultAvatar,
    });
    accessStore.setAccessCodes(userInfo.accessCodes);
    return userInfo;
  }

  /** 会话过期：由请求适配层在刷新失败时调用，只清本地态，不主动跳转。 */
  function markSessionExpired() {
    sessionState.value = 'expired';
    accessStore.setAccessToken(null);
    accessStore.setAccessCodes([]);
    userStore.setUserInfo(null);
  }

  function $reset() {
    loginLoading.value = false;
    sessionState.value = 'idle';
    lastSessionError.value = null;
  }

  return {
    $reset,
    authLogin,
    fetchUserInfo,
    lastSessionError,
    loginLoading,
    logout,
    markSessionExpired,
    sessionState,
  };
});
