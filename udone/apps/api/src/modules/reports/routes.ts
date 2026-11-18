import { Hono } from 'hono';
import type { Context } from 'hono';
import { PERMISSIONS, ROUTES, reportQuerySchema } from '@erp/contracts';
import { parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { reportRepository } from './report-service';

/**
 * 租户报表（R-REPORT-01）：总览与供应商统计共用数据库口径函数。
 * 读要 order.read——报表展示的是订单范围，不该比订单列表更容易看到。
 */
export const reportRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext) {
  return context.env.REPORT_REPOSITORY ?? reportRepository(context.env, context.get('authToken'));
}

reportRoutes.get(
  ROUTES.getTenantReport.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const query = parseQuery(context, reportQuerySchema);
    const result = await repository(context).tenant(query, context.get('auth').organizationId);
    return respond(context, 'getTenantReport', result);
  },
);

reportRoutes.get(
  ROUTES.getSupplierReport.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const query = parseQuery(context, reportQuerySchema);
    const result = await repository(context).suppliers(query, context.get('auth').organizationId);
    return respond(context, 'getSupplierReport', result);
  },
);
