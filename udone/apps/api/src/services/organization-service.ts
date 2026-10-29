import type { AuthRole } from '@erp/contracts';
import type { ApiEnvironment } from '../middleware/auth';
import { RestConflictError, createRestClient } from '../lib/rest-client';

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
  const client = createRestClient(environment, token);

  return {
    async getMemberships(userId) {
      const rows = await client.rest<MembershipRow[]>(
        `organization_members?user_id=eq.${encodeURIComponent(userId)}&status=eq.active&select=organization_id,role,organizations(name)`,
      );
      return rows.map(toMembership);
    },

    async createWithOwner({ name }) {
      // The RPC derives ownership from auth.uid(); clients cannot choose an owner.
      try {
        const rows = await client.rest<
          Array<{
            organization_id: string;
            organization_name: string;
            membership_role: AuthRole;
          }>
        >('rpc/create_organization_with_owner', {
          method: 'POST',
          body: { requested_name: name },
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
      } catch (cause) {
        if (cause instanceof RestConflictError) throw new OrganizationConflictError();
        throw cause;
      }
    },

    async findMembership(userId, organizationId) {
      const rows = await client.rest<MembershipRow[]>(
        `organization_members?user_id=eq.${encodeURIComponent(userId)}&organization_id=eq.${encodeURIComponent(organizationId)}&status=eq.active&select=organization_id,role,organizations(name)&limit=1`,
      );
      return rows[0] ? toMembership(rows[0]) : null;
    },

    async listMembers(organizationId) {
      const rows = await client.rest<
        Array<{ user_id: string; role: AuthRole; status: 'active' | 'disabled' }>
      >(
        `organization_members?organization_id=eq.${encodeURIComponent(organizationId)}&select=user_id,role,status`,
        { organizationId },
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
