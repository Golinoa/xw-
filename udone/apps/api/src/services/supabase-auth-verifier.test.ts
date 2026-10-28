import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '../../../../packages/contracts/src';
import { createSupabaseAuthVerifier } from './supabase-auth-verifier';

function tokenFor(claims: Record<string, unknown>) {
  const payload = btoa(JSON.stringify(claims))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${payload}.signature`;
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SupabaseAuthVerifier', () => {
  it('verifies the bearer with Supabase and resolves only the selected user membership', async () => {
    const token = tokenFor({ sub: 'user-fixture', session_id: 'session-fixture' });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ id: 'user-fixture' }))
      .mockResolvedValueOnce(response([{ organization_id: 'org-beta', role: 'operator', permissions: ['organization.read'], data_scope: 'own' }]));
    const verifier = createSupabaseAuthVerifier(
      {
        SUPABASE_URL: 'https://fixture.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
      },
      fetcher,
    );

    await expect(verifier.verify(token, 'org-beta')).resolves.toEqual({
      userId: 'user-fixture',
      organizationId: 'org-beta',
      role: 'operator',
      sessionId: 'session-fixture',
      permissions: ['organization.read'],
      dataScope: 'own',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('apikey')).toBe(
      'fixture-publishable-key',
    );
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('X-Organization-ID')).toBe(
      'org-beta',
    );
    expect(String(fetcher.mock.calls[1][0])).toContain('/rpc/get_current_auth_context');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ requested_organization_id: 'org-beta' });
  });

  it('rejects invalid users, malformed tokens, and nonmember organization contexts', async () => {
    const invalid = createSupabaseAuthVerifier(
      {
        SUPABASE_URL: 'https://fixture.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'fixture-key',
      },
      vi.fn().mockResolvedValue(response({ message: 'invalid' }, 401)),
    );
    await expect(invalid.verify('not-a-jwt')).resolves.toBeNull();

    const token = tokenFor({ sub: 'user-fixture', session_id: 'session-fixture' });
    const nonmember = createSupabaseAuthVerifier(
      {
        SUPABASE_URL: 'https://fixture.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'fixture-key',
      },
      vi
        .fn()
        .mockResolvedValueOnce(response({ id: 'user-fixture' }))
        .mockResolvedValueOnce(response([{ organization_id: 'org-alpha', role: 'admin' }])),
    );
    await expect(nonmember.verify(token, 'org-outside')).resolves.toBeNull();
  });

  it('rejects a disabled organization membership during each protected request', async () => {
    const token = tokenFor({ sub: 'user-fixture', session_id: 'session-fixture' });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ id: 'user-fixture' }))
      .mockResolvedValueOnce(response([]));
    const verifier = createSupabaseAuthVerifier(
      {
        SUPABASE_URL: 'https://fixture.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'fixture-key',
      },
      fetcher,
    );

    await expect(verifier.verify(token, 'org-disabled')).resolves.toBeNull();
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('/rest/v1/rpc/get_current_auth_context');
  });

  it('uses the verified membership role for API permissions', async () => {
    const verifier = createSupabaseAuthVerifier(
      {
        SUPABASE_URL: 'https://fixture.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'fixture-key',
      },
      vi.fn(),
    );
    const context = { userId: 'u', organizationId: 'o', role: 'operator' as const, sessionId: 's', permissions: ['organization.read'] as const, dataScope: 'own' as const };

    await expect(verifier.hasPermission(context, PERMISSIONS.ORGANIZATION_READ)).resolves.toBe(
      true,
    );
    await expect(verifier.hasPermission(context, PERMISSIONS.MEMBER_MANAGE)).resolves.toBe(false);
  });
});
