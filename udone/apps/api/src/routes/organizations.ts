import { Hono } from 'hono';
import {
  createOrganizationRequestSchema,
  ERROR_CODES,
  organizationParamsSchema,
  PERMISSIONS,
  ROUTES,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../lib/contract';
import { authVerifier, requireAuth } from '../middleware/auth';
import type { ApiEnvironment } from '../middleware/auth';
import { ApiHttpError } from '../middleware/error-handler';
import {
  OrganizationConflictError,
  organizationRepository,
} from '../services/organization-service';

export const organizationRoutes = new Hono<ApiEnvironment>();
organizationRoutes.use(ROUTES.me.path, requireAuth());
organizationRoutes.use('/api/organizations/*', requireAuth());

organizationRoutes.get(ROUTES.me.path, async (context) => {
  const auth = context.get('auth');
  const repository = organizationRepository(context.env, context.get('authToken'));
  const memberships = await repository.getMemberships(auth.userId);
  return respond(context, 'me', { userId: auth.userId, memberships });
});

organizationRoutes.post(ROUTES.createOrganization.path, async (context) => {
  const { name } = await parseJson(context, createOrganizationRequestSchema);

  const auth = context.get('auth');
  const repository = organizationRepository(context.env, context.get('authToken'));
  try {
    const created = await repository.createWithOwner({ name, ownerId: auth.userId });
    return respond(context, 'createOrganization', created, 201);
  } catch (error) {
    if (error instanceof OrganizationConflictError) {
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'Organization membership already exists');
    }
    throw error;
  }
});

organizationRoutes.post(ROUTES.switchOrganization.path, async (context) => {
  const auth = context.get('auth');
  const { id: organizationId } = parseParams(context, organizationParamsSchema);
  const selected = await authVerifier(context.env).verify(context.get('authToken'), organizationId);
  if (!selected || selected.userId !== auth.userId || selected.organizationId !== organizationId) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'You are not a member of this organization');
  }

  return respond(context, 'switchOrganization', selected);
});

organizationRoutes.get(ROUTES.listMembers.path, async (context) => {
  const auth = context.get('auth');
  const { id: organizationId } = parseParams(context, organizationParamsSchema);
  const selectedOrganizationId = context.req.header('X-Organization-ID');
  if (
    !selectedOrganizationId ||
    selectedOrganizationId !== organizationId ||
    organizationId !== auth.organizationId
  ) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'You cannot access this organization');
  }

  const verifier = authVerifier(context.env);
  const canManage = await verifier.hasPermission(auth, PERMISSIONS.MEMBER_MANAGE);
  const canRead = canManage || (await verifier.hasPermission(auth, PERMISSIONS.ORGANIZATION_READ));
  if (!canRead) {
    throw new ApiHttpError(
      403,
      ERROR_CODES.FORBIDDEN,
      'You do not have permission to read members',
    );
  }

  const repository = organizationRepository(context.env, context.get('authToken'));
  const members = await repository.listMembers(organizationId);
  return respond(context, 'listMembers', { members });
});
