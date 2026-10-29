import { computed, ref } from 'vue';
import type {
  AuthContext,
  AuthRole,
  OrganizationInvitation,
  OrganizationMembership,
} from '@erp/contracts';
import { createApiClient } from '../lib/api-client';
import { supabase } from '../lib/supabase';

export interface AuthUser {
  id: string;
  email?: string;
}
export interface AuthSession {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  user: AuthUser;
}
export type Membership = OrganizationMembership;
export type { OrganizationInvitation } from '@erp/contracts';
interface AuthClient {
  auth: {
    getSession(): Promise<{ data: { session: AuthSession | null }; error: Error | null }>;
    onAuthStateChange(callback: (event: string, session: AuthSession | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
    signInWithPassword(input: {
      email: string;
      password: string;
      options?: { captchaToken: string };
    }): Promise<{ data: { session: AuthSession | null }; error: Error | null }>;
    resetPasswordForEmail(
      email: string,
      options?: { captchaToken?: string; redirectTo?: string },
    ): Promise<{ data: unknown; error: Error | null }>;
    updateUser(input: { password: string }): Promise<{ data: unknown; error: Error | null }>;
    signOut(): Promise<{ error: Error | null }>;
  };
}
type Fetcher = typeof fetch;

export function createAuthStore(options: { client?: AuthClient | null; fetcher?: Fetcher } = {}) {
  const client =
    options.client === undefined ? (supabase as unknown as AuthClient | null) : options.client;
  const fetcher = options.fetcher ?? fetch;
  const session = ref<AuthSession | null>(null);
  const user = ref<AuthUser | null>(null);
  const memberships = ref<Membership[]>([]);
  const currentOrganization = ref<Membership | null>(null);
  const initialized = ref(false);
  const loading = ref(false);
  const error = ref('');
  const recoveryMessage = ref('');
  const recoveryMode = ref(false);
  let subscription: { unsubscribe(): void } | undefined;

  const api = createApiClient({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
    getAccessToken: () => session.value?.access_token ?? null,
    getOrganizationId: () => currentOrganization.value?.organizationId ?? null,
    fetcher,
  });

  function clearIdentity() {
    session.value = null;
    user.value = null;
    memberships.value = [];
    currentOrganization.value = null;
  }

  async function loadMemberships() {
    const result = await api.call('me');
    if (result.userId !== session.value?.user.id) throw new Error('登录用户与成员信息不一致');
    memberships.value = result.memberships;
    if (
      !memberships.value.some(
        (membership) => membership.organizationId === currentOrganization.value?.organizationId,
      )
    ) {
      currentOrganization.value = memberships.value[0] ?? null;
    } else {
      currentOrganization.value =
        memberships.value.find(
          (membership) => membership.organizationId === currentOrganization.value?.organizationId,
        ) ?? null;
    }
  }

  async function applySession(value: AuthSession | null) {
    if (!value) {
      clearIdentity();
      return;
    }
    session.value = value;
    user.value = value.user;
    try {
      await loadMemberships();
    } catch {
      memberships.value = [];
      currentOrganization.value = null;
      error.value = '当前账号尚未加入公司；请使用有效邀请链接加入。';
    }
  }

  async function initialize() {
    if (initialized.value) return;
    initialized.value = true;
    if (!client) {
      error.value = '登录服务尚未配置';
      return;
    }
    loading.value = true;
    try {
      const result = await client.auth.getSession();
      if (result.error) throw result.error;
      await applySession(result.data.session);
      subscription = client.auth.onAuthStateChange((event, value) => {
        recoveryMode.value = event === 'PASSWORD_RECOVERY';
        void applySession(value).catch((cause: unknown) => {
          error.value = cause instanceof Error ? cause.message : '读取成员信息失败';
        });
      }).data.subscription;
    } catch (cause) {
      clearIdentity();
      error.value = cause instanceof Error ? cause.message : '初始化登录状态失败';
    } finally {
      loading.value = false;
    }
  }

  async function signIn(email: string, password: string, captchaToken?: string) {
    if (!client) {
      error.value = '登录服务尚未配置';
      return false;
    }
    loading.value = true;
    error.value = '';
    try {
      const result = await client.auth.signInWithPassword({
        email,
        password,
        ...(captchaToken ? { options: { captchaToken } } : {}),
      });
      if (result.error) throw result.error;
      if (!result.data.session) throw new Error('登录服务未返回会话');
      await applySession(result.data.session);
      return true;
    } catch {
      clearIdentity();
      error.value = '邮箱或密码错误，或账号暂不可用';
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function resetPassword(email: string, captchaToken?: string) {
    if (!client) {
      recoveryMessage.value = '如果该邮箱已注册，我们会发送密码重置邮件。';
      return true;
    }
    loading.value = true;
    error.value = '';
    recoveryMessage.value = '';
    try {
      await client.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        ...(captchaToken || typeof window !== 'undefined'
          ? [
              {
                ...(captchaToken ? { captchaToken } : {}),
                ...(typeof window !== 'undefined'
                  ? { redirectTo: `${window.location.origin}/login` }
                  : {}),
              },
            ]
          : []),
      );
    } catch {
      // Keep the response indistinguishable for registered and unregistered addresses.
    } finally {
      recoveryMessage.value = '如果该邮箱已注册，我们会发送密码重置邮件。';
      loading.value = false;
    }
    return true;
  }

  async function updatePassword(password: string) {
    if (!client) {
      error.value = '密码更新暂不可用';
      return false;
    }
    loading.value = true;
    error.value = '';
    try {
      const result = await client.auth.updateUser({ password });
      if (result.error) throw result.error;
      const signOutResult = await client.auth.signOut();
      if (signOutResult.error) throw signOutResult.error;
      clearIdentity();
      recoveryMode.value = false;
      recoveryMessage.value = '密码已更新，请使用新密码重新登录。';
      return true;
    } catch {
      error.value = '密码更新失败，请重新申请密码重置邮件';
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function acceptInvitation(invitationId: string) {
    error.value = '';
    try {
      await api.call('acceptInvitation', { params: { invitationId } });
      await loadMemberships();
      error.value = '';
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '邀请暂不可用';
      return false;
    }
  }

  async function createInvitation(
    email: string,
    role: AuthRole,
  ): Promise<OrganizationInvitation | null> {
    const organizationId = currentOrganization.value?.organizationId;
    if (!organizationId) {
      error.value = '请先选择公司';
      return null;
    }
    error.value = '';
    try {
      const result = await api.call('inviteMember', {
        params: { id: organizationId },
        body: { email, role },
      });
      return result.invitation;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '邀请发送失败';
      return null;
    }
  }

  async function updateMember(userId: string, role: AuthRole, status: 'active' | 'disabled') {
    const organizationId = currentOrganization.value?.organizationId;
    if (!organizationId) {
      error.value = '请先选择公司';
      return false;
    }
    error.value = '';
    try {
      await api.call('updateMember', {
        params: { id: organizationId, userId },
        body: { role, status },
      });
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '成员更新失败';
      return false;
    }
  }

  async function signOut() {
    loading.value = true;
    error.value = '';
    try {
      if (client) {
        const result = await client.auth.signOut();
        if (result.error) throw result.error;
      }
      clearIdentity();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '退出登录失败';
      throw cause;
    } finally {
      loading.value = false;
    }
  }

  async function switchOrganization(organizationId: string) {
    const target = memberships.value.find((item) => item.organizationId === organizationId);
    if (!target || !currentOrganization.value) {
      error.value = '无权切换到该公司';
      return false;
    }
    loading.value = true;
    error.value = '';
    try {
      const context: AuthContext = await api.call('switchOrganization', {
        params: { id: organizationId },
      });
      if (
        context.userId !== user.value?.id ||
        context.organizationId !== target.organizationId ||
        context.role !== target.role
      ) {
        throw new Error('服务器返回的公司上下文与成员信息不一致');
      }
      currentOrganization.value = target;
      await loadMemberships();
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '切换公司失败';
      return false;
    } finally {
      loading.value = false;
    }
  }

  return {
    session,
    user,
    memberships,
    currentOrganization,
    initialized,
    loading,
    error,
    recoveryMessage,
    recoveryMode,
    isAuthenticated: computed(() => session.value !== null),
    initialize,
    signIn,
    resetPassword,
    updatePassword,
    acceptInvitation,
    createInvitation,
    updateMember,
    signOut,
    switchOrganization,
    dispose() {
      subscription?.unsubscribe();
    },
  };
}

let defaultStore: ReturnType<typeof createAuthStore> | undefined;
export function useAuthStore() {
  return (defaultStore ??= createAuthStore());
}
