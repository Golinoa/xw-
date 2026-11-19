import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  convertLeadToOrderRequestSchema,
  createLeadRequestSchema,
  followUpLeadRequestSchema,
  leadFunnelQuerySchema,
  leadActionRequestSchema,
  leadListQuerySchema,
} from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { leadRepository } from './lead-service';

/** CRM 线索与公海（R-CRM-01/02）。读要 order.read，写要 order.write。 */
export const leadRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext) {
  return context.env.LEAD_REPOSITORY ?? leadRepository(context.env, context.get('authToken'));
}

function fail(error: string | null | undefined): never {
  switch (error) {
    case 'VERSION_CONFLICT':
      throw new ApiHttpError(409, ERROR_CODES.STATE_CONFLICT, 'Lead was changed by someone else', {
        reason: 'VERSION_MISMATCH',
      });
    case 'NOT_OWNER':
      throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'Only the owner can follow up this lead');
    case 'STAGE_NOT_WON':
      throw new ApiHttpError(409, ERROR_CODES.STATE_CONFLICT, 'Only a won lead can be converted', {
        reason: 'STAGE_NOT_WON',
      });
    case 'NOT_FOUND':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Lead not found');
    case 'OWNER_NOT_MEMBER':
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The assignee is not a member');
    default:
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Invalid lead operation', {
        error,
      });
  }
}

leadRoutes.get(
  ROUTES.listLeads.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const query = parseQuery(context, leadListQuerySchema);
    const page = await repository(context).list(query, context.get('auth').organizationId);
    return respond(context, 'listLeads', page);
  },
);

leadRoutes.get(
  ROUTES.getLeadFunnel.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const query = parseQuery(context, leadFunnelQuerySchema);
    const summary = await repository(context).funnel(query, context.get('auth').organizationId);
    return respond(context, 'getLeadFunnel', summary);
  },
);

leadRoutes.get(
  ROUTES.getLead.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const params = parseParams(context, ROUTES.getLead.request);
    const detail = await repository(context).get(params.leadId, context.get('auth').organizationId);
    if (!detail) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Lead not found');
    return respond(context, 'getLead', detail);
  },
);

leadRoutes.post(
  ROUTES.createLead.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const body = await parseJson(context, createLeadRequestSchema);
    const result = await repository(context).create(body, context.get('auth').organizationId);
    if (result.error) fail(result.error);
    return respond(context, 'createLead', { leadId: result.leadId! });
  },
);

leadRoutes.post(
  ROUTES.followUpLead.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const body = await parseJson(context, followUpLeadRequestSchema);
    const error = await repository(context).followUp(body, context.get('auth').organizationId);
    if (error) fail(error);
    return respond(context, 'followUpLead', { success: true });
  },
);

leadRoutes.post(
  ROUTES.claimLead.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const body = await parseJson(context, leadActionRequestSchema);
    const error = await repository(context).claim(body, context.get('auth').organizationId);
    if (error) fail(error);
    return respond(context, 'claimLead', { success: true });
  },
);

leadRoutes.post(
  ROUTES.assignLead.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const body = await parseJson(context, leadActionRequestSchema);
    if (!body.ownerId) {
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'ownerId is required', {
        field: 'ownerId',
      });
    }
    const error = await repository(context).assign(
      { leadId: body.leadId, version: body.version, ownerId: body.ownerId },
      context.get('auth').organizationId,
    );
    if (error) fail(error);
    return respond(context, 'assignLead', { success: true });
  },
);

leadRoutes.post(
  ROUTES.convertLeadToOrder.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const body = await parseJson(context, convertLeadToOrderRequestSchema);
    const result = await repository(context).convertToOrder(
      body,
      context.get('auth').organizationId,
    );
    if (result.error) fail(result.error);
    return respond(context, 'convertLeadToOrder', { orderId: result.orderId! });
  },
);

leadRoutes.post(
  ROUTES.convertLead.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const body = await parseJson(context, ROUTES.convertLead.request);
    const result = await repository(context).convert(
      body.leadId,
      context.get('auth').organizationId,
    );
    if (result.error) fail(result.error);
    return respond(context, 'convertLead', { customerId: result.customerId! });
  },
);
