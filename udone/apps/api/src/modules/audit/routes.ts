import { Hono } from 'hono';
import type { Context } from 'hono';
import { PERMISSIONS, ROUTES, auditListQuerySchema } from '@erp/contracts';
import { parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import type { AuditRepository } from './audit-service';
import { auditRepository } from './audit-service';

/**
 * 租户侧审计查询（R-AUDIT-01）。
 *
 * 只读，且读也要 audit.read —— 与数据库 RLS 策略是同一道门的两层。
 * 审计表没有任何写/删端点：能改的日志不是证据。
 */
export const auditRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext): AuditRepository {
  return context.env.AUDIT_REPOSITORY ?? auditRepository(context.env, context.get('authToken'));
}

auditRoutes.get(
  ROUTES.listAuditFacets.path,
  requireAuth(),
  requirePermission(PERMISSIONS.AUDIT_READ),
  async (context) => {
    const facets = await repository(context).facets(context.get('auth').organizationId);
    return respond(context, 'listAuditFacets', facets);
  },
);

auditRoutes.get(
  ROUTES.listAuditEvents.path,
  requireAuth(),
  requirePermission(PERMISSIONS.AUDIT_READ),
  async (context) => {
    const query = parseQuery(context, auditListQuerySchema);
    const page = await repository(context).list(query, context.get('auth').organizationId);
    return respond(context, 'listAuditEvents', page);
  },
);
