/**
 * ERP 会话状态机（Supabase Auth + 多租户组织上下文）。
 *
 * 与 ops 后台的差异：
 * 1. 凭据走 Supabase `signInWithPassword`，不再有 `/ops/auth/login` 与 HttpOnly 刷新 Cookie；
 *    access token 由 Supabase 客户端自动续期，落 sessionStorage（关标签页即失效）。
 * 2. 授权不是「动作码」而是「组织成员角色」，故 `accessCodes` 恒为空；
 *    页面可见性由路由 `meta.authority` 决定（阶段 1 的路由均不设 authority）。
 * 3. 组织上下文通过请求头 `X-Organization-Id` 传递，由 `lib/api-client` 统一注入。
 */
import type {
  AuthContext,
  AuthRole,
  OrganizationInvitation,
  OrganizationMembership,
} from '@erp/contracts';

import type { Recordable } from '@vben/types';

import { computed, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';
import { preferences } from '@vben/preferences';
import { resetAllStores, useAccessStore, useUserStore } from '@vben/stores';

import { defineStore } from 'pinia';

import { ApiClientError, createApiClient } from '#/lib/api-client';
import { supabase } from '#/lib/supabase';

export type SessionState =
  | 'authenticated'
  | 'authenticating'
  | 'expired'
  | 'failed'
  | 'idle'
  | 'network_error'
  | 'no_membership';

export type Membership = OrganizationMembership;

interface SupabaseUser {
  email?: string;
  id: string;
}

interface SupabaseSession {
  access_token: string;
  refresh_token?: string;
  user: SupabaseUser;
}

/**
 * 只声明本模块用到的 Supabase Auth 能力，避免把整个 SDK 类型拉进 store，
 * 也让单测可以直接注入一个假客户端。
 */
interface AuthClient {
  auth: {
    getSession(): Promise<{
      data: { session: null | SupabaseSession };
      error: Error | null;
    }>;
    onAuthStateChange(
      callback: (event: string, session: null | SupabaseSession) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
    resetPasswordForEmail(
      email: string,
      options?: { captchaToken?: string; redirectTo?: string },
    ): Promise<{ data: unknown; error: Error | null }>;
    signInWithPassword(input: {
      email: string;
      options?: { captchaToken: string };
      password: string;
    }): Promise<{
      data: { session: null | SupabaseSession };
      error: Error | null;
    }>;
    signOut(): Promise<{ error: Error | null }>;
    updateUser(input: {
      password: string;
    }): Promise<{ data: unknown; error: Error | null }>;
  };
}

/** 登录失败统一成带 `code`/`status` 的错误，供登录页内联归类。 */
function toSessionError(cause: unknown): ApiClientError {
  if (cause instanceof ApiClientError) {
    return cause;
  }
  const shape = (cause ?? {}) as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof shape.code === 'string' ? shape.code : 'AUTH_REQUIRED';
  const status = typeof shape.status === 'number' ? shape.status : 401;
  const message =
    typeof shape.message === 'string' && shape.message
      ? shape.message
      : '邮箱或密码错误，或账号暂不可用';
  return new ApiClientError(code, message, status);
}

export const useAuthStore = defineStore('auth', () => {
  const accessStore = useAccessStore();
  const userStore = useUserStore();
  const router = useRouter();

  const authClient = supabase as unknown as AuthClient | null;

  const session = shallowRef<null | SupabaseSession>(null);
  const memberships = ref<Membership[]>([]);
  const currentOrganization = ref<Membership | null>(null);

  const initialized = ref(false);
  const loginLoading = ref(false);
  const sessionState = ref<SessionState>('idle');
  const lastSessionError = shallowRef<ApiClientError | null>(null);
  const notice = ref('');
  /**
   * 密码恢复模式：Supabase 重置邮件回跳后，用户必须先设置新密码才能进业务页。
   * 该状态下**不写 accessToken**，否则守卫会把人直接放进工作台，跳过设置密码。
   */
  const recoveryMode = ref(false);

  let subscription: undefined | { unsubscribe(): void };

  const api = createApiClient({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
    getAccessToken: () => session.value?.access_token ?? null,
    getOrganizationId: () => currentOrganization.value?.organizationId ?? null,
  });

  const isAuthenticated = computed(() => session.value !== null);

  function clearIdentity() {
    session.value = null;
    memberships.value = [];
    currentOrganization.value = null;
  }

  /** 本地清会话：内存 token、用户信息、权限码、访问检查标记。 */
  function clearLocalSession() {
    clearIdentity();
    resetAllStores();
    accessStore.setAccessToken(null);
    accessStore.setAccessCodes([]);
    accessStore.setLoginExpired(false);
    userStore.setUserInfo(null);
  }

  function buildUserInfo() {
    const email = session.value?.user.email ?? '';
    const role = currentOrganization.value?.role;
    return {
      avatar: preferences.app.defaultAvatar,
      realName: email || '未命名用户',
      username: email,
      userId: session.value?.user.id ?? '',
      // 与 `preferences.app.defaultHomePath` 保持一致，避免守卫与 Root redirect 出现两个首页
      homePath: preferences.app.defaultHomePath,
      roles: role ? [role] : [],
      /**
       * ERP 授权粒度是组织角色，不存在动作码。这里保持空数组而不是伪造码，
       * 避免 `v-access:code` 出现「看起来配了其实永不命中」的假授权。
       */
      accessCodes: [] as string[],
    };
  }

  async function loadMemberships() {
    const result = await api.call('me');
    if (result.userId !== session.value?.user.id) {
      throw new Error('登录用户与成员信息不一致');
    }
    memberships.value = result.memberships;
    const currentId = currentOrganization.value?.organizationId;
    const matched = memberships.value.find((item) => item.organizationId === currentId);
    currentOrganization.value = matched ?? memberships.value[0] ?? null;
  }

  /** 把 Supabase 会话写进 Vben 的 store；失败不吞，由调用方决定提示方式。 */
  async function applySession(value: null | SupabaseSession) {
    if (!value) {
      clearLocalSession();
      return;
    }
    session.value = value;
    accessStore.setAccessToken(value.access_token);

    try {
      await loadMemberships();
    } catch (error) {
      memberships.value = [];
      currentOrganization.value = null;
      userStore.setUserInfo(buildUserInfo());
      throw toSessionError(error);
    }

    userStore.setUserInfo(buildUserInfo());

    /**
     * 无组织归属时**保留会话**，只把状态标成 `no_membership`。
     *
     * 旧前端就是这个口径：被邀请人第一次登录时还没有成员记录，必须先拿着 token
     * 调 `acceptInvitation`；若在这里清会话，邀请流程永远走不通。
     * 代价是这类账号会进到工作台看到「尚未加入公司」，与旧前端一致。
     */
    sessionState.value = memberships.value.length === 0 ? 'no_membership' : 'authenticated';
  }

  /**
   * 重置邮件回跳的识别。
   *
   * Supabase 隐式流把令牌放在 hash 里：`#access_token=...&type=recovery`。
   * 必须在 `getSession()` 之前判断——`getSession` 会触发 URL 里令牌的落地，
   * 一旦先落进 store，守卫就会把用户直接放进业务页，跳过「设置新密码」。
   */
  function hasRecoveryRedirect() {
    if (typeof window === 'undefined') return false;
    const { hash, search } = window.location;
    return (
      /(?:^|[#&?])type=recovery(?:&|$)/.test(hash) ||
      /(?:^|[?&])type=recovery(?:&|$)/.test(search)
    );
  }

  /**
   * 恢复会话（幂等）。必须在路由守卫判定 accessToken 之前执行，
   * 否则刷新页面会把已登录用户送回登录页。
   */
  async function initialize() {
    if (initialized.value) {
      return;
    }
    initialized.value = true;

    if (!authClient) {
      sessionState.value = 'failed';
      lastSessionError.value = new ApiClientError(
        'AUTH_REQUIRED',
        '登录服务尚未配置：缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_PUBLISHABLE_KEY',
        500,
      );
      return;
    }

    recoveryMode.value = hasRecoveryRedirect();

    try {
      const result = await authClient.auth.getSession();
      if (result.error) {
        throw result.error;
      }
      if (!recoveryMode.value) {
        await applySession(result.data.session);
        if (session.value) {
          sessionState.value =
            memberships.value.length > 0 ? 'authenticated' : 'no_membership';
        } else {
          sessionState.value = 'idle';
        }
      }
    } catch (error) {
      // 会话存在但拉不到成员信息：保留会话让用户能重试，不直接踢回登录页。
      sessionState.value = session.value ? 'no_membership' : 'idle';
      if (session.value) {
        lastSessionError.value = toSessionError(error);
      }
    }

    subscription = authClient.auth.onAuthStateChange((event, value) => {
      if (event === 'PASSWORD_RECOVERY') {
        // 令牌只留在 Supabase 客户端内部（`updateUser` 需要它），不进 store。
        clearLocalSession();
        recoveryMode.value = true;
        sessionState.value = 'idle';
        return;
      }
      if (event === 'SIGNED_OUT') {
        clearLocalSession();
        sessionState.value = 'idle';
        return;
      }
      if (recoveryMode.value) {
        return;
      }
      void applySession(value).catch((error: unknown) => {
        lastSessionError.value = toSessionError(error);
      });
    }).data.subscription;
  }

  /**
   * 登录。失败时抛出带 `code`/`status` 的错误，由登录页内联呈现，
   * 这里不弹全局 toast——否则会遮挡表单并丢失已填内容。
   */
  async function authLogin(
    params: Recordable<any>,
    onSuccess?: () => Promise<void> | void,
  ) {
    const email = String(params?.email ?? params?.username ?? '').trim();
    const password = String(params?.password ?? '');
    const captchaToken = params?.captchaToken
      ? String(params.captchaToken)
      : undefined;

    loginLoading.value = true;
    sessionState.value = 'authenticating';
    lastSessionError.value = null;
    notice.value = '';

    try {
      if (!authClient) {
        throw new ApiClientError(
          'AUTH_REQUIRED',
          '登录服务尚未配置：缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_PUBLISHABLE_KEY',
          500,
        );
      }

      const result = await authClient.auth.signInWithPassword({
        email,
        password,
        ...(captchaToken ? { options: { captchaToken } } : {}),
      });
      if (result.error) {
        throw result.error;
      }
      if (!result.data.session) {
        throw new ApiClientError(
          'AUTH_REQUIRED',
          '登录服务未返回会话',
          500,
        );
      }

      await applySession(result.data.session);

      const userInfo = userStore.userInfo;
      await (onSuccess ? onSuccess() : router.push(userInfo?.homePath || preferences.app.defaultHomePath));

      return { userInfo };
    } catch (error_) {
      const error = toSessionError(error_);
      clearLocalSession();
      sessionState.value =
        error.code === 'FORBIDDEN' ? 'no_membership' : 'failed';
      lastSessionError.value = error;
      throw error;
    } finally {
      loginLoading.value = false;
    }
  }

  /** 拉取当前用户信息（守卫在 token 存在但 userInfo 缺失时调用）。 */
  async function fetchUserInfo() {
    if (!session.value) {
      throw new ApiClientError('AUTH_REQUIRED', '登录状态已失效，请重新登录', 401);
    }
    await loadMemberships();
    const userInfo = buildUserInfo();
    userStore.setUserInfo(userInfo);
    return userInfo;
  }

  async function logout(redirect: boolean = true) {
    try {
      if (authClient) {
        const result = await authClient.auth.signOut();
        if (result.error) {
          throw result.error;
        }
      }
    } catch (error) {
      // 服务端登出失败不应阻塞本地清理，但要留痕便于排查
      console.warn('supabase signOut failed', error);
    }

    clearLocalSession();
    sessionState.value = 'idle';
    lastSessionError.value = null;
    notice.value = '';

    const { resetRoutes } = await import('#/router');
    resetRoutes();

    await router.replace({
      path: LOGIN_PATH,
      // 不在这里 encode：`vue-router` 序列化 query 时会自行编码，
      // 手动 encode 会与守卫「读取端不解码」的约定冲突，回跳目标变成 `%2F...` 字面量。
      query: redirect ? { redirect: router.currentRoute.value.fullPath } : {},
    });
  }

  async function resetPassword(email: string, captchaToken?: string) {
    if (!authClient) {
      notice.value = '如果该邮箱已注册，我们会发送密码重置邮件。';
      return true;
    }
    loginLoading.value = true;
    try {
      await authClient.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        ...(captchaToken ? { captchaToken } : {}),
        ...(typeof window === 'undefined'
          ? {}
          : { redirectTo: `${window.location.origin}/auth/login` }),
      });
    } catch {
      // 已注册与未注册必须给出同样的响应，避免枚举账号。
    } finally {
      notice.value = '如果该邮箱已注册，我们会发送密码重置邮件。';
      loginLoading.value = false;
    }
    return true;
  }

  async function updatePassword(password: string) {
    if (!authClient) {
      notice.value = '密码更新暂不可用';
      return false;
    }
    loginLoading.value = true;
    try {
      const result = await authClient.auth.updateUser({ password });
      if (result.error) {
        throw result.error;
      }
      await authClient.auth.signOut();
      clearLocalSession();
      recoveryMode.value = false;
      notice.value = '密码已更新，请使用新密码重新登录。';
      return true;
    } catch {
      notice.value = '密码更新失败，请重新申请密码重置邮件';
      return false;
    } finally {
      loginLoading.value = false;
    }
  }

  async function acceptInvitation(invitationId: string) {
    try {
      await api.call('acceptInvitation', { params: { invitationId } });
      await loadMemberships();
      userStore.setUserInfo(buildUserInfo());
      return true;
    } catch (error) {
      lastSessionError.value = toSessionError(error);
      return false;
    }
  }

  async function createInvitation(
    email: string,
    role: AuthRole,
  ): Promise<null | OrganizationInvitation> {
    const organizationId = currentOrganization.value?.organizationId;
    if (!organizationId) {
      return null;
    }
    try {
      const result = await api.call('inviteMember', {
        body: { email, role },
        params: { id: organizationId },
      });
      return result.invitation;
    } catch (error) {
      lastSessionError.value = toSessionError(error);
      return null;
    }
  }

  /** 调整成员角色 / 启停。失败原因写进 `lastSessionError`，由调用页面就地展示。 */
  async function updateMember(
    userId: string,
    role: AuthRole,
    status: 'active' | 'disabled',
  ): Promise<boolean> {
    const organizationId = currentOrganization.value?.organizationId;
    if (!organizationId) {
      lastSessionError.value = new ApiClientError('ORG_CONTEXT_REQUIRED', '请先选择公司', 400);
      return false;
    }
    try {
      await api.call('updateMember', {
        body: { role, status },
        params: { id: organizationId, userId },
      });
      return true;
    } catch (error) {
      lastSessionError.value = toSessionError(error);
      return false;
    }
  }

  /**
   * 切换公司。服务端返回的上下文必须与本地成员信息一致，
   * 否则说明两端数据漂移，宁可报错也不要把请求头换成错误组织。
   */
  async function switchOrganization(organizationId: string) {
    const target = memberships.value.find(
      (item) => item.organizationId === organizationId,
    );
    if (!target || !currentOrganization.value) {
      return false;
    }
    loginLoading.value = true;
    try {
      const context: AuthContext = await api.call('switchOrganization', {
        params: { id: organizationId },
      });
      if (
        context.userId !== session.value?.user.id ||
        context.organizationId !== target.organizationId ||
        context.role !== target.role
      ) {
        throw new Error('服务器返回的公司上下文与成员信息不一致');
      }
      currentOrganization.value = target;
      await loadMemberships();
      userStore.setUserInfo(buildUserInfo());
      return true;
    } catch (error) {
      lastSessionError.value = toSessionError(error);
      return false;
    } finally {
      loginLoading.value = false;
    }
  }

  /** 会话过期：由请求层在刷新失败时调用，只清本地态，不主动跳转。 */
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
    notice.value = '';
    recoveryMode.value = false;
  }

  function dispose() {
    subscription?.unsubscribe();
    subscription = undefined;
  }

  return {
    $reset,
    acceptInvitation,
    api,
    authLogin,
    createInvitation,
    currentOrganization,
    dispose,
    fetchUserInfo,
    initialize,
    initialized,
    isAuthenticated,
    lastSessionError,
    loginLoading,
    logout,
    markSessionExpired,
    memberships,
    notice,
    recoveryMode,
    resetPassword,
    session,
    sessionState,
    switchOrganization,
    updateMember,
    updatePassword,
  };
});
