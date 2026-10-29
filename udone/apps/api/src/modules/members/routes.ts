import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createOrganizationInvitationRequestSchema,
  ERROR_CODES,
  invitationParamsSchema,
  memberParamsSchema,
  PERMISSIONS,
  ROUTES,
  updateOrganizationMemberRequestSchema,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../../lib/contract';
import { requireAuth, requirePermission } from '../../middleware/auth';
import type { ApiEnvironment } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { acceptInvitation, createInvitation, isMemberRole, updateMember } from './member-service';

export const memberRoutes = new Hono<ApiEnvironment>();
memberRoutes.use('/api/organizations/*', requireAuth());

/** 组织上下文必须与路径、已验证身份一致，否则一律拒绝。 */
function selectedOrganization(context: Context<ApiEnvironment>, organizationId: string) {
  const selected = context.req.header('X-Organization-ID');
  if (
    !selected ||
    selected !== organizationId ||
    organizationId !== context.get('auth').organizationId
  ) {
    throw new ApiHttpError(
      403,
      ERROR_CODES.FORBIDDEN,
      'You cannot manage members in this organization',
    );
  }
}

memberRoutes.post(
  ROUTES.inviteMember.path,
  requirePermission(PERMISSIONS.MEMBER_MANAGE),
  async (context) => {
    const { id: organizationId } = parseParams(context, memberParamsSchema.pick({ id: true }));
    selectedOrganization(context, organizationId);
    const { email, role } = await parseJson(context, createOrganizationInvitationRequestSchema);
    if (!isMemberRole(role)) {
      throw new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'A valid email and assignable role are required',
      );
    }
    const invitation = await createInvitation(
      context.env,
      context.get('authToken'),
      organizationId,
      email,
      role,
    );
    return respond(
      context,
      'inviteMember',
      {
        invitation: {
          id: invitation.id,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
        },
      },
      invitation.created ? 201 : 200,
    );
  },
);

memberRoutes.patch(
  ROUTES.updateMember.path,
  requirePermission(PERMISSIONS.MEMBER_MANAGE),
  async (context) => {
    const { id: organizationId, userId } = parseParams(context, memberParamsSchema);
    selectedOrganization(context, organizationId);
    const { role, status } = await parseJson(context, updateOrganizationMemberRequestSchema);
    const member = await updateMember(
      context.env,
      context.get('authToken'),
      organizationId,
      userId,
      role,
      status,
    );
    return respond(context, 'updateMember', { member });
  },
);

memberRoutes.post(ROUTES.acceptInvitation.path, async (context) => {
  const bearer = context.req.header('Authorization')?.match(/^Bearer\s+(\S+)$/i);
  if (!bearer) throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
  const { invitationId } = parseParams(context, invitationParamsSchema);
  const membership = await acceptInvitation(context.env, bearer[1], invitationId);
  return respond(context, 'acceptInvitation', { membership }, 201);
});
