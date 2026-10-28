import { Hono } from 'hono';
import { ERROR_CODES, PERMISSIONS } from '../../../../packages/contracts/src';
import { authVerifier, requireAuth } from '../middleware/auth';
import { ApiHttpError } from '../middleware/error-handler';
import type { ApiEnvironment } from '../middleware/auth';
import {
  OrganizationConflictError,
  organizationRepository,
} from '../services/organization-service';

export const organizationRoutes = new Hono<ApiEnvironment>();
organizationRoutes.use('/api/me', requireAuth());
organizationRoutes.use('/api/organizations/*', requireAuth());

organizationRoutes.get('/api/me', async (context) => {
  const auth = context.get('auth');
  const repository = organizationRepository(context.env, context.get('authToken'));
  const memberships = await repository.getMemberships(auth.userId);
  return context.json({ userId: auth.userId, memberships });
});

organizationRoutes.post('/api/organizations', async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'A valid JSON body is required');
  }

  const name =
    typeof body === 'object' && body !== null && 'name' in body
      ? (body as { name?: unknown }).name
      : undefined;
  if (typeof name !== 'string' || !name.trim()) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Organization name is required');
  }

  const auth = context.get('auth');
  const repository = organizationRepository(context.env, context.get('authToken'));
  try {
    const created = await repository.createWithOwner({ name: name.trim(), ownerId: auth.userId });
    return context.json(created, 201);
  } catch (error) {
    if (error instanceof OrganizationConflictError) {
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'Organization membership already exists');
    }
    throw error;
  }
});

organizationRoutes.post('/api/organizations/:id/switch', async (context) => {
  const auth = context.get('auth');
  const organizationId = context.req.param('id');
  const selected = await authVerifier(context.env).verify(context.get('authToken'), organizationId);
  if (!selected || selected.userId !== auth.userId || selected.organizationId !== organizationId) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'You are not a member of this organization');
  }

  return context.json(selected);
});

organizationRoutes.get('/api/organizations/:id/members', async (context) => {
  const auth = context.get('auth');
  const organizationId = context.req.param('id');
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
  return context.json({ members: await repository.listMembers(organizationId) });
});
