import type { AuthRole } from '@erp/contracts';
import { ERROR_CODES } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { RestConflictError, RestRequestError, createRestClient } from '../../lib/rest-client';

type MemberRole = AuthRole;
type MemberStatus = 'active' | 'disabled';
type Invitation = { id: string; status: 'pending'; expiresAt: string; created: boolean };

async function rpc<T>(
  environment: ApiEnvironment['Bindings'],
  token: string,
  name: string,
  payload: unknown,
  organizationId?: string,
): Promise<T> {
  const client = createRestClient(environment, token);
  try {
    return await client.rest<T>(`rpc/${name}`, {
      method: 'POST',
      body: payload,
      organizationId,
    });
  } catch (cause) {
    if (cause instanceof RestConflictError) {
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'An invitation already exists for this email',
      );
    }
    if (cause instanceof RestRequestError && (cause.status === 400 || cause.status === 422)) {
      throw new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'The membership request is invalid',
      );
    }
    if (cause instanceof RestRequestError) {
      throw new ApiHttpError(
        500,
        ERROR_CODES.INTERNAL_ERROR,
        'Membership change could not be completed',
      );
    }
    throw cause;
  }
}

async function sendInvitationEmail(
  environment: ApiEnvironment['Bindings'],
  email: string,
  invitationId: string,
): Promise<void> {
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'Invitation delivery is not configured',
    );
  }
  const client = createRestClient(environment, '');
  const redirect = environment.APP_BASE_URL
    ? `${environment.APP_BASE_URL.replace(/\/$/, '')}/login?invitationId=${encodeURIComponent(invitationId)}`
    : undefined;
  const redirectQuery = redirect ? `?redirect_to=${encodeURIComponent(redirect)}` : '';
  const adminResponse = await client.auth(`/auth/v1/invite${redirectQuery}`, {
    method: 'POST',
    apiKey: serviceKey,
    bearer: serviceKey,
    body: { email },
  });
  if (adminResponse.ok) return;

  // Existing Auth identities cannot be invited a second time; send a recovery link
  // to the same email with the invitation return path, without exposing account state.
  if (adminResponse.status === 409 || adminResponse.status === 422) {
    const recoveryResponse = await client.auth(`/auth/v1/recover${redirectQuery}`, {
      method: 'POST',
      body: { email },
    });
    if (recoveryResponse.ok) return;
  }
  throw new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'Invitation email could not be sent');
}

export async function createInvitation(
  environment: ApiEnvironment['Bindings'],
  token: string,
  organizationId: string,
  email: string,
  role: MemberRole,
): Promise<Invitation> {
  if (!environment.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'Invitation delivery is not configured',
    );
  }
  const rows = await rpc<
    Array<{
      invitation_id: string;
      invitation_status: 'pending';
      invitation_expires_at: string;
      invitation_created: boolean;
    }>
  >(
    environment,
    token,
    'create_organization_invitation',
    {
      requested_organization_id: organizationId,
      requested_email: email,
      requested_role: role,
    },
    organizationId,
  );
  const row = rows[0];
  if (!row)
    throw new ApiHttpError(500, ERROR_CODES.INTERNAL_ERROR, 'Invitation could not be created');
  if (row.invitation_created) await sendInvitationEmail(environment, email, row.invitation_id);
  return {
    id: row.invitation_id,
    status: row.invitation_status,
    expiresAt: row.invitation_expires_at,
    created: row.invitation_created,
  };
}

export async function updateMember(
  environment: ApiEnvironment['Bindings'],
  token: string,
  organizationId: string,
  userId: string,
  role: AuthRole,
  status: MemberStatus,
) {
  const rows = await rpc<
    Array<{ user_id: string; member_role: AuthRole; member_status: MemberStatus }>
  >(
    environment,
    token,
    'update_organization_member',
    {
      requested_organization_id: organizationId,
      requested_user_id: userId,
      requested_role: role,
      requested_status: status,
    },
    organizationId,
  );
  const row = rows[0];
  if (!row) throw new ApiHttpError(404, ERROR_CODES.VALIDATION_ERROR, 'Member was not found');
  return { userId: row.user_id, role: row.member_role, status: row.member_status };
}

export async function acceptInvitation(
  environment: ApiEnvironment['Bindings'],
  token: string,
  invitationId: string,
): Promise<{ organizationId: string; role: AuthRole }> {
  const userResponse = await createRestClient(environment, token).auth('/auth/v1/user', {
    bearer: token,
  });
  if (!userResponse.ok)
    throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
  const user = (await userResponse.json()) as {
    id?: unknown;
    email_confirmed_at?: unknown;
    confirmed_at?: unknown;
  };
  if (typeof user.id !== 'string' || (!user.email_confirmed_at && !user.confirmed_at)) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'A verified email is required');
  }
  const rows = await rpc<Array<{ organization_id: string; membership_role: AuthRole }>>(
    environment,
    token,
    'accept_organization_invitation',
    { requested_invitation_id: invitationId },
  );
  const row = rows[0];
  if (!row) throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'Invitation is unavailable');
  return { organizationId: row.organization_id, role: row.membership_role };
}

export function isMemberRole(value: unknown): value is MemberRole {
  return value === 'admin' || value === 'operator' || value === 'finance';
}
