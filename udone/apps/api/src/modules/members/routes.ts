import { Hono } from 'hono';
import {
  createOrganizationInvitationRequestSchema,
  ERROR_CODES,
  PERMISSIONS,
  updateOrganizationMemberRequestSchema,
} from '../../../../../packages/contracts/src';
import { requireAuth, requirePermission } from '../../middleware/auth';
import type { ApiEnvironment } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { acceptInvitation, createInvitation, isMemberRole, updateMember } from './member-service';

export const memberRoutes = new Hono<ApiEnvironment>();
memberRoutes.use('/api/organizations/*', requireAuth());
memberRoutes.post('/api/organizations/:id/invitations', requirePermission(PERMISSIONS.MEMBER_MANAGE), async (context) => {
  const organizationId = context.req.param('id');
  const selectedOrganizationId = context.req.header('X-Organization-ID');
  if (!selectedOrganizationId || selectedOrganizationId !== organizationId || organizationId !== context.get('auth').organizationId) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'You cannot manage members in this organization');
  }
  let body: unknown;
  try { body = await context.req.json(); } catch {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'A valid JSON body is required');
  }
  const input = createOrganizationInvitationRequestSchema.safeParse(body);
  if (!input.success || !isMemberRole(input.data.role)) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'A valid email and assignable role are required');
  }
  const invitation = await createInvitation(context.env, context.get('authToken'), organizationId, input.data.email, input.data.role);
  return context.json({ invitation: { id: invitation.id, status: invitation.status, expiresAt: invitation.expiresAt } }, invitation.created ? 201 : 200);
});

memberRoutes.patch('/api/organizations/:id/members/:userId', requirePermission(PERMISSIONS.MEMBER_MANAGE), async (context) => {
  const organizationId = context.req.param('id');
  const selectedOrganizationId = context.req.header('X-Organization-ID');
  if (!selectedOrganizationId || selectedOrganizationId !== organizationId || organizationId !== context.get('auth').organizationId) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'You cannot manage members in this organization');
  }
  let body: unknown;
  try { body = await context.req.json(); } catch {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'A valid JSON body is required');
  }
  const input = updateOrganizationMemberRequestSchema.safeParse(body);
  if (!input.success) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'A valid role and membership status are required');
  }
  const member = await updateMember(context.env, context.get('authToken'), organizationId, context.req.param('userId'), input.data.role, input.data.status);
  return context.json({ member });
});

memberRoutes.post('/api/invitations/:invitationId/accept', async (context) => {
  const bearer = context.req.header('Authorization')?.match(/^Bearer\s+(\S+)$/i);
  if (!bearer) throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
  const membership = await acceptInvitation(context.env, bearer[1], context.req.param('invitationId'));
  return context.json({ membership }, 201);
});
