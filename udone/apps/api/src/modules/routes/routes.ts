import { Hono } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  createTourRouteRequestSchema,
  tourRouteListQuerySchema,
  tourRouteParamsSchema,
  updateTourRouteRequestSchema,
} from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { TourRouteNameConflictError, tourRouteRepository } from './route-service';

/**
 * 线路主数据（R-ROUTE-01）。
 *
 * 读权限 `route.read` 决定「能不能在订单里选到线路」，写权限 `route.write`
 * 决定「能不能新增 / 改名 / 启停 / 删除」。财务只读：他们要按线路核对金额，
 * 但不该改公司口径。
 */
export const routeRoutes = new Hono<ApiEnvironment>();

function routeConflict(cause: unknown): never {
  if (cause instanceof TourRouteNameConflictError) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'A route with this name exists');
  }
  throw cause;
}

routeRoutes.get(
  ROUTES.listRoutes.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ROUTE_READ),
  async (context) => {
    const query = parseQuery(context, tourRouteListQuerySchema);
    const page = await tourRouteRepository(context.env, context.get('authToken')).list({
      organizationId: context.get('auth').organizationId,
      keyword: query.keyword,
      // 下拉只要启用的；管理页传 activeOnly=false 才看得到停用线路。
      activeOnly: query.activeOnly !== 'false',
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });
    return respond(context, 'listRoutes', {
      items: page.items,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

routeRoutes.post(
  ROUTES.createRoute.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ROUTE_WRITE),
  async (context) => {
    const input = await parseJson(context, createTourRouteRequestSchema);
    const route = await tourRouteRepository(context.env, context.get('authToken'))
      .create(context.get('auth').organizationId, input)
      .catch(routeConflict);
    return respond(context, 'createRoute', { route }, 201);
  },
);

routeRoutes.patch(
  ROUTES.updateRoute.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ROUTE_WRITE),
  async (context) => {
    const { routeId } = parseParams(context, tourRouteParamsSchema);
    const input = await parseJson(context, updateTourRouteRequestSchema);
    const route = await tourRouteRepository(context.env, context.get('authToken'))
      .update(context.get('auth').organizationId, routeId, input)
      .catch(routeConflict);
    if (!route) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Route not found');
    }
    return respond(context, 'updateRoute', { route });
  },
);

routeRoutes.delete(
  ROUTES.deleteRoute.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ROUTE_WRITE),
  async (context) => {
    const { routeId } = parseParams(context, tourRouteParamsSchema);
    const deleted = await tourRouteRepository(context.env, context.get('authToken')).remove(
      context.get('auth').organizationId,
      routeId,
    );
    if (!deleted) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Route not found');
    }
    return respond(context, 'deleteRoute', { deletedRouteId: routeId });
  },
);
