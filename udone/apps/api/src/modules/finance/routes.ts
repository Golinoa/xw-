import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  financeListQuerySchema,
  orderParamsSchema,
  payableListQuerySchema,
  summarizeOrderFinance,
} from '@erp/contracts';
import { parseParams, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { orderRepository } from '../orders/order-service';
import type { FinanceRepository } from './finance-service';
import { financeRepository } from './finance-service';

export const financeRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext): FinanceRepository {
  return financeRepository(context.env, context.get('authToken'));
}

/**
 * 应收、应付、订单财务摘要都只用 `order.read` 一个权限。
 *
 * 财务明细是订单的子资源：能看订单的人本来就该看到自己订单的金额与未收未付，
 * 否则订单列表上摆着「未收 7,500」却点不进去，只能算半开的门。
 * 真正需要独立权限的是「申请收付款」这类**写**动作（R-FIN-02/03），
 * 等做到审批流时再引入 `finance.write`，那时才有「能看不能付」的实际含义。
 */
financeRoutes.get(
  ROUTES.getOrderFinance.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const { orderId } = parseParams(context, orderParamsSchema);
    const order = await orderRepository(context.env, context.get('authToken')).findById(
      context.get('auth').organizationId,
      orderId,
    );
    if (!order) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Order not found');
    // 摘要完全由明细算出；订单表上的合计列不参与，避免「缓存没重算」时返回旧数字。
    return respond(context, 'getOrderFinance', {
      finance: summarizeOrderFinance({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        personCount: order.personCount,
        receivables: order.receivables,
        payables: order.payables,
      }),
    });
  },
);

financeRoutes.get(
  ROUTES.listReceivables.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const query = parseQuery(context, financeListQuerySchema);
    const page = await repository(context).listReceivables({
      organizationId: context.get('auth').organizationId,
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.keyword ? { keyword: query.keyword } : {}),
      ...(query.outstanding ? { outstanding: query.outstanding } : {}),
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });
    return respond(context, 'listReceivables', {
      items: page.items,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

financeRoutes.get(
  ROUTES.listPayables.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const query = parseQuery(context, payableListQuerySchema);
    const page = await repository(context).listPayables({
      organizationId: context.get('auth').organizationId,
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.keyword ? { keyword: query.keyword } : {}),
      ...(query.outstanding ? { outstanding: query.outstanding } : {}),
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });
    return respond(context, 'listPayables', {
      items: page.items,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);
