import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type AuthContext } from '../../../../packages/contracts/src';
import { app } from '../index';
import type { ApiEnvironment } from '../middleware/auth';
import {
  OrganizationConflictError,
  type OrganizationRepository,
} from '../services/organization-service';

const current: AuthContext = {
  userId: 'user-owner',
  organizationId: 'org-alpha',
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['organization.read', 'member.manage', 'settings.manage', 'audit.read'],
  dataScope: 'all',
};

function setup(repository: OrganizationRepository, identity: AuthContext = current) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(
        async (context, permission) =>
          context.organizationId === 'org-alpha' &&
          ['organization.read', 'member.manage'].includes(permission),
      ),
    },
    ORGANIZATION_REPOSITORY: repository,
  };
  return { testApp, env };
}

describe('organization routes', () => {
  it('returns the current user and all memberships', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn().mockResolvedValue([
        { organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'admin' },
        { organizationId: 'org-beta', organizationName: 'Beta Travel', role: 'operator' },
      ]),
      createWithOwner: vi.fn(),
      findMembership: vi.fn(),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository);
    const response = await testApp.request(
      '/api/me',
      {
        headers: { Authorization: 'Bearer valid-token' },
      },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: 'user-owner',
      memberships: [
        { organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'admin' },
        { organizationId: 'org-beta', organizationName: 'Beta Travel', role: 'operator' },
      ],
    });
    expect(repository.getMemberships).toHaveBeenCalledWith('user-owner');
  });

  it('creates an organization with its owner membership atomically', async () => {
    const created = {
      organization: { id: 'org-new', name: 'New Travel' },
      membership: {
        organizationId: 'org-new',
        organizationName: 'New Travel',
        role: 'admin' as const,
      },
    };
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn().mockResolvedValue(created),
      findMembership: vi.fn(),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/organizations',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Travel' }),
      },
      env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(created);
    expect(repository.createWithOwner).toHaveBeenCalledWith({
      name: 'New Travel',
      ownerId: 'user-owner',
    });
  });

  it('returns CONFLICT when atomic owner membership creation hits a uniqueness conflict', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn().mockRejectedValue(new OrganizationConflictError()),
      findMembership: vi.fn(),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/organizations',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Travel' }),
      },
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects switching to an organization where the user has no membership', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn(),
      findMembership: vi.fn().mockResolvedValue(null),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository);
    env.AUTH_VERIFIER!.verify = vi.fn(async (_token, organizationId) =>
      organizationId === 'org-other' ? null : current,
    );

    const response = await testApp.request(
      '/api/organizations/org-other/switch',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token' },
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(env.AUTH_VERIFIER!.verify).toHaveBeenCalledWith('valid-token', 'org-other');
  });

  it('returns the selected membership context after validating membership', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn(),
      findMembership: vi.fn().mockResolvedValue({
        organizationId: 'org-beta',
        organizationName: 'Beta Travel',
        role: 'operator',
      }),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository);
    const selected: AuthContext = {
      userId: 'user-owner',
      organizationId: 'org-beta',
      role: 'operator',
      sessionId: 'session-1',
      permissions: ['organization.read'],
      dataScope: 'own',
    };
    env.AUTH_VERIFIER!.verify = vi.fn(async (_token, organizationId) =>
      organizationId === 'org-beta' ? selected : current,
    );

    const response = await testApp.request(
      '/api/organizations/org-beta/switch',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token' },
      },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: 'user-owner',
      organizationId: 'org-beta',
      role: 'operator',
      sessionId: 'session-1',
      permissions: ['organization.read'],
      dataScope: 'own',
    });
  });

  it('lists members when either read or manage permission is present', async () => {
    const members = [{ userId: 'user-owner', role: 'admin', status: 'active' as const }];
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn(),
      findMembership: vi.fn(),
      listMembers: vi.fn().mockResolvedValue(members),
    };
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/organizations/org-alpha/members',
      {
        headers: { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' },
      },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ members });
    expect(repository.listMembers).toHaveBeenCalledWith('org-alpha');
  });

  it('denies cross-organization member reads before querying the repository', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn(),
      findMembership: vi.fn(),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/organizations/org-beta/members',
      {
        headers: { Authorization: 'Bearer valid-token' },
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.listMembers).not.toHaveBeenCalled();
  });

  it('denies member reads without an explicit selected organization header', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn(),
      findMembership: vi.fn(),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/organizations/org-alpha/members',
      {
        headers: { Authorization: 'Bearer valid-token' },
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.listMembers).not.toHaveBeenCalled();
  });

  it('requires at least one of the two allowed permissions for the member list', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn(),
      findMembership: vi.fn(),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository, { ...current, role: 'operator' });
    env.AUTH_VERIFIER!.hasPermission = vi.fn().mockResolvedValue(false);

    const response = await testApp.request(
      '/api/organizations/org-alpha/members',
      {
        headers: { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' },
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.listMembers).not.toHaveBeenCalled();
  });

  it('allows member reads with organization.read even without member.manage', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn(),
      findMembership: vi.fn(),
      listMembers: vi.fn().mockResolvedValue([]),
    };
    const { testApp, env } = setup(repository);
    env.AUTH_VERIFIER!.hasPermission = vi.fn(
      async (_context, permission) => permission === PERMISSIONS.ORGANIZATION_READ,
    );

    const response = await testApp.request(
      '/api/organizations/org-alpha/members',
      {
        headers: { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' },
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(env.AUTH_VERIFIER!.hasPermission).toHaveBeenNthCalledWith(
      1,
      current,
      PERMISSIONS.MEMBER_MANAGE,
    );
    expect(env.AUTH_VERIFIER!.hasPermission).toHaveBeenNthCalledWith(
      2,
      current,
      PERMISSIONS.ORGANIZATION_READ,
    );
    expect(repository.listMembers).toHaveBeenCalledWith('org-alpha');
  });

  it('rejects a malformed invitation email before calling Supabase', async () => {
    const repository: OrganizationRepository = {
      getMemberships: vi.fn(),
      createWithOwner: vi.fn(),
      findMembership: vi.fn(),
      listMembers: vi.fn(),
    };
    const { testApp, env } = setup(repository);
    env.SUPABASE_URL = 'https://fixture.supabase.co';
    env.SUPABASE_PUBLISHABLE_KEY = 'fixture-publishable-key';
    env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-role';
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const response = await testApp.request(
      '/api/organizations/org-alpha/invitations',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'X-Organization-ID': 'org-alpha',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'not-an-email', role: 'operator' }),
      },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
