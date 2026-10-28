import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseOrganizationRepository } from './organization-service';

const environment = {
  SUPABASE_URL: 'https://fixture.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
};

afterEach(() => vi.unstubAllGlobals());

describe('Supabase organization repository request context', () => {
  it('sends the verified organization and caller token when listing its members', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ user_id: 'user-one', role: 'admin', status: 'active' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);

    const repository = createSupabaseOrganizationRepository(environment, 'caller-token');
    await expect(repository.listMembers('org-one')).resolves.toEqual([
      { userId: 'user-one', role: 'admin', status: 'active' },
    ]);

    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer caller-token');
    expect(headers.get('X-Organization-ID')).toBe('org-one');
  });

  it('omits selected organization context during membership discovery and creation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              organization_id: 'org-new',
              organization_name: 'New Org',
              membership_role: 'admin',
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);

    const repository = createSupabaseOrganizationRepository(environment, 'caller-token');
    await repository.getMemberships('user-one');
    await repository.createWithOwner({ name: 'New Org', ownerId: 'user-one' });

    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('X-Organization-ID')).toBe(false);
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).has('X-Organization-ID')).toBe(false);
  });
});
