import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptInvitation, createInvitation, updateMember } from './member-service';

const environment = {
  SUPABASE_URL: 'https://fixture.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
  APP_BASE_URL: 'https://app.example.test',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('member service', () => {
  it('stores invitations with the caller JWT and confines service role to Auth Admin', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json([
          {
            invitation_id: 'invite-1',
            invitation_status: 'pending',
            invitation_expires_at: '2026-10-12T00:00:00Z',
            invitation_created: true,
          },
        ]),
      )
      .mockResolvedValueOnce(json({ id: 'auth-user-1' }));
    vi.stubGlobal('fetch', fetcher);

    await expect(
      createInvitation(environment, 'caller-user-jwt', 'org-1', 'staff@example.test', 'operator'),
    ).resolves.toEqual({
      id: 'invite-1',
      status: 'pending',
      expiresAt: '2026-10-12T00:00:00Z',
      created: true,
    });

    const rpcHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    const adminHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      '/rest/v1/rpc/create_organization_invitation',
    );
    expect(rpcHeaders.get('Authorization')).toBe('Bearer caller-user-jwt');
    expect(rpcHeaders.get('X-Organization-ID')).toBe('org-1');
    expect(adminHeaders.get('Authorization')).toBe('Bearer fixture-service-role');
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('/auth/v1/invite?redirect_to=');
    const inviteUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(inviteUrl.searchParams.get('redirect_to')).toBe(
      'https://app.example.test/login?invitationId=invite-1',
    );
  });

  it('does not send a duplicate provider invitation when the database reports a replay', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      json([
        {
          invitation_id: 'invite-1',
          invitation_status: 'pending',
          invitation_expires_at: '2026-10-12T00:00:00Z',
          invitation_created: false,
        },
      ]),
    );
    vi.stubGlobal('fetch', fetcher);

    const invitation = await createInvitation(
      environment,
      'caller-user-jwt',
      'org-1',
      'staff@example.test',
      'operator',
    );

    expect(invitation.created).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('sends existing identities a non-enumerating recovery email with the invitation return path', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json([
          {
            invitation_id: 'invite-2',
            invitation_status: 'pending',
            invitation_expires_at: '2026-10-12T00:00:00Z',
            invitation_created: true,
          },
        ]),
      )
      .mockResolvedValueOnce(json({ message: 'already registered' }, 422))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    const invitation = await createInvitation(
      environment,
      'caller-user-jwt',
      'org-1',
      'existing@example.test',
      'finance',
    );

    expect(invitation.status).toBe('pending');
    expect(String(fetcher.mock.calls[2]?.[0])).toContain('/auth/v1/recover?redirect_to=');
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('Authorization')).toBeNull();
  });

  it('accepts invitations with a verified Auth session and caller JWT', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ id: 'user-1', email_confirmed_at: '2026-10-05T00:00:00Z' }))
      .mockResolvedValueOnce(json([{ organization_id: 'org-1', membership_role: 'operator' }]));
    vi.stubGlobal('fetch', fetcher);

    await expect(acceptInvitation(environment, 'invitee-user-jwt', 'invite-1')).resolves.toEqual({
      organizationId: 'org-1',
      role: 'operator',
    });
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('/rpc/accept_organization_invitation');
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer invitee-user-jwt',
    );
  });

  it('updates member role and status only through the caller-authorized database RPC', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json([{ user_id: 'user-2', member_role: 'finance', member_status: 'disabled' }]),
      );
    vi.stubGlobal('fetch', fetcher);

    await expect(
      updateMember(environment, 'admin-user-jwt', 'org-1', 'user-2', 'finance', 'disabled'),
    ).resolves.toEqual({
      userId: 'user-2',
      role: 'finance',
      status: 'disabled',
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/rpc/update_organization_member');
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer admin-user-jwt',
    );
  });
});
