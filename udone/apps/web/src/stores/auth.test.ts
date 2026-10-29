import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import type { AuthContext, AuthRole } from '@erp/contracts';
import { createAppRouter } from '../router';
import { createAuthStore, type AuthSession, type Membership } from './auth';

const session: AuthSession = {
  access_token: 'fixture-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'fixture-refresh-token',
  user: { id: 'user-fixture', email: 'staff@example.test' },
};

const memberships: Membership[] = [
  { organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'admin' },
  { organizationId: 'org-beta', organizationName: 'Beta Travel', role: 'operator' },
];

function createClient(initialSession: AuthSession | null = null) {
  let onChange: ((event: string, value: AuthSession | null) => void) | undefined;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: initialSession }, error: null }),
      onAuthStateChange: vi.fn((callback: (event: string, value: AuthSession | null) => void) => {
        onChange = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: null }),
      updateUser: vi.fn().mockResolvedValue({ data: { user: session.user }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      emit: (event: string, value: AuthSession | null) => onChange?.(event, value),
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('frontend auth store', () => {
  it('loads an existing session and the user memberships', async () => {
    const client = createClient(session);
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse({ userId: 'user-fixture', memberships }));
    const store = createAuthStore({ client, fetcher });

    await store.initialize();

    expect(store.session.value).toEqual(session);
    expect(store.user.value?.id).toBe('user-fixture');
    expect(store.memberships.value).toEqual(memberships);
    expect(store.currentOrganization.value).toEqual(memberships[0]);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-access-token' }),
      }),
    );
  });

  it('signs in with the Supabase client and loads memberships', async () => {
    const client = createClient();
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse({ userId: 'user-fixture', memberships }));
    const store = createAuthStore({ client, fetcher });

    await store.initialize();
    await expect(store.signIn('staff@example.test', 'fixture-password')).resolves.toBe(true);

    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'staff@example.test',
      password: 'fixture-password',
    });
    expect(client.auth.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(store.session.value).toEqual(session);
    expect(store.currentOrganization.value?.organizationId).toBe('org-alpha');
  });

  it('shows a generic sign-in error when Supabase rejects credentials', async () => {
    const client = createClient();
    client.auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: new Error('User not found'),
    });
    const store = createAuthStore({ client, fetcher: vi.fn() });

    await expect(store.signIn('missing@example.test', 'wrong-password')).resolves.toBe(false);

    expect(store.error.value).toBe('邮箱或密码错误，或账号暂不可用');
    expect(store.error.value).not.toContain('User not found');
    expect(store.session.value).toBeNull();
  });

  it('uses a non-enumerating confirmation for password recovery requests', async () => {
    const client = createClient();
    const store = createAuthStore({ client, fetcher: vi.fn() });

    await expect(store.resetPassword('staff@example.test')).resolves.toBe(true);

    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith('staff@example.test');
    expect(store.recoveryMessage.value).toBe('如果该邮箱已注册，我们会发送密码重置邮件。');
  });

  it('passes a configured CAPTCHA token to Supabase Auth without storing it', async () => {
    const client = createClient();
    const store = createAuthStore({ client, fetcher: vi.fn() });

    await expect(
      store.signIn('staff@example.test', 'fixture-password', 'one-time-captcha'),
    ).resolves.toBe(true);

    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'staff@example.test',
      password: 'fixture-password',
      options: { captchaToken: 'one-time-captcha' },
    });
    expect(store.error.value).not.toContain('one-time-captcha');
  });

  it('creates an organization invitation through the authenticated API and exposes its pending status', async () => {
    const client = createClient(session);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ userId: 'user-fixture', memberships }))
      .mockResolvedValueOnce(
        jsonResponse(
          { invitation: { id: 'invite-1', status: 'pending', expiresAt: '2026-10-12T00:00:00Z' } },
          201,
        ),
      );
    const store = createAuthStore({ client, fetcher });
    await store.initialize();

    await expect(store.createInvitation('staff2@example.test', 'operator')).resolves.toEqual({
      id: 'invite-1',
      status: 'pending',
      expiresAt: '2026-10-12T00:00:00Z',
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/organizations/org-alpha/invitations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'staff2@example.test', role: 'operator' }),
        headers: expect.objectContaining({
          Authorization: 'Bearer fixture-access-token',
          'X-Organization-ID': 'org-alpha',
        }),
      }),
    );
  });

  it('clears the session and membership state after sign-out', async () => {
    const client = createClient(session);
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse({ userId: 'user-fixture', memberships }));
    const store = createAuthStore({ client, fetcher });
    await store.initialize();

    await store.signOut();

    expect(client.auth.signOut).toHaveBeenCalledOnce();
    expect(store.session.value).toBeNull();
    expect(store.user.value).toBeNull();
    expect(store.memberships.value).toEqual([]);
    expect(store.currentOrganization.value).toBeNull();
  });

  it('validates organization switching then sends the new context on later API requests', async () => {
    const selectedContext: AuthContext = {
      userId: 'user-fixture',
      organizationId: 'org-beta',
      role: 'operator' satisfies AuthRole,
      sessionId: 'session-fixture',
      permissions: ['organization.read'],
      dataScope: 'own',
    };
    const client = createClient(session);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ userId: 'user-fixture', memberships }))
      .mockResolvedValueOnce(jsonResponse(selectedContext))
      .mockResolvedValueOnce(jsonResponse({ userId: 'user-fixture', memberships }));
    const store = createAuthStore({ client, fetcher });
    await store.initialize();

    await expect(store.switchOrganization('org-beta')).resolves.toBe(true);

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/organizations/org-beta/switch',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fixture-access-token',
          'X-Organization-ID': 'org-alpha',
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      '/api/me',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Organization-ID': 'org-beta' }),
      }),
    );
    expect(store.currentOrganization.value?.organizationId).toBe('org-beta');
    expect(store.currentOrganization.value?.role).toBe('operator');
  });

  it('redirects a protected route to login when no session exists', async () => {
    const store = createAuthStore({ client: createClient(), fetcher: vi.fn() });
    const router = createAppRouter(store, createMemoryHistory());

    await router.push('/');
    await router.isReady();

    expect(router.currentRoute.value.path).toBe('/login');
  });
});
