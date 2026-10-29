import type { AuthRole } from '@erp/contracts';
import { ApiHttpError } from '../middleware/error-handler';
import type { ApiEnvironment } from '../middleware/auth';
import { ERROR_CODES } from '@erp/contracts';

export interface OrganizationMembership {
  organizationId: string;
  organizationName: string;
  role: AuthRole;
}

export interface OrganizationMember {
  userId: string;
  role: AuthRole;
  status: 'active' | 'disabled';
}

export interface CreatedOrganization {
  organization: { id: string; name: string };
  membership: OrganizationMembership;
}

export interface OrganizationRepository {
  getMemberships(userId: string): Promise<OrganizationMembership[]>;
  createWithOwner(input: { name: string; ownerId: string }): Promise<CreatedOrganization>;
  findMembership(userId: string, organizationId: string): Promise<OrganizationMembership | null>;
  listMembers(organizationId: string): Promise<OrganizationMember[]>;
}

export class OrganizationConflictError extends Error {
  constructor() {
    super('Organization membership conflict');
    this.name = 'OrganizationConflictError';
  }
}

function databaseUrl(environment: ApiEnvironment['Bindings']): string {
  if (!environment.SUPABASE_URL || !environment.SUPABASE_PUBLISHABLE_KEY) {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'Organization storage is not configured',
    );
  }
  return environment.SUPABASE_URL.replace(/\/$/, '');
}

async function supabaseRequest<T>(
  environment: ApiEnvironment['Bindings'],
  token: string,
  path: string,
  init: RequestInit = {},
  organizationId?: string,
): Promise<T> {
  const response = await fetch(`${databaseUrl(environment)}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: environment.SUPABASE_PUBLISHABLE_KEY!,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
      ...(organizationId ? { 'X-Organization-ID': organizationId } : {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { code?: string } | null;
    if (response.status === 409 || payload?.code === '23505') {
      throw new OrganizationConflictError();
    }
    throw new Error(`Organization storage request failed (${response.status})`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

type MembershipRow = {
  organization_id: string;
  role: AuthRole;
  organizations: { name: string } | null;
};

function toMembership(row: MembershipRow): OrganizationMembership {
  if (!row.organizations) throw new Error('Organization membership has no organization');
  return {
    organizationId: row.organization_id,
    organizationName: row.organizations.name,
    role: row.role,
  };
}

export function createSupabaseOrganizationRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): OrganizationRepository {
  return {
    async getMemberships(userId) {
      const rows = await supabaseRequest<MembershipRow[]>(
        environment,
        token,
        `organization_members?user_id=eq.${encodeURIComponent(userId)}&status=eq.active&select=organization_id,role,organizations(name)`,
      );
      return rows.map(toMembership);
    },

    async createWithOwner({ name }) {
      // The RPC derives ownership from auth.uid(); clients cannot choose an owner.
      const rows = await supabaseRequest<
        Array<{
          organization_id: string;
          organization_name: string;
          membership_role: AuthRole;
        }>
      >(environment, token, 'rpc/create_organization_with_owner', {
        method: 'POST',
        body: JSON.stringify({ requested_name: name }),
      });
      const created = rows[0];
      if (!created) throw new Error('Organization creation returned no result');
      return {
        organization: { id: created.organization_id, name: created.organization_name },
        membership: {
          organizationId: created.organization_id,
          organizationName: created.organization_name,
          role: created.membership_role,
        },
      };
    },

    async findMembership(userId, organizationId) {
      const rows = await supabaseRequest<MembershipRow[]>(
        environment,
        token,
        `organization_members?user_id=eq.${encodeURIComponent(userId)}&organization_id=eq.${encodeURIComponent(organizationId)}&status=eq.active&select=organization_id,role,organizations(name)&limit=1`,
      );
      return rows[0] ? toMembership(rows[0]) : null;
    },

    async listMembers(organizationId) {
      const rows = await supabaseRequest<
        Array<{ user_id: string; role: AuthRole; status: 'active' | 'disabled' }>
      >(
        environment,
        token,
        `organization_members?organization_id=eq.${encodeURIComponent(organizationId)}&select=user_id,role,status`,
        {},
        organizationId,
      );
      return rows.map((row) => ({ userId: row.user_id, role: row.role, status: row.status }));
    },
  };
}

export function organizationRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): OrganizationRepository {
  return (
    environment.ORGANIZATION_REPOSITORY ?? createSupabaseOrganizationRepository(environment, token)
  );
}
