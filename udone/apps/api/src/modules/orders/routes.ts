import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  createOrderRequestSchema,
  orderListQuerySchema,
  orderParamsSchema,
  transitionOrderRequestSchema,
  updateOrderRequestSchema,
} from '@erp/contracts';
import type { OrderDetail, OrderListItem } from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import type { OrderRecord, OrderRepository } from './order-service';
import { OrderCustomerInvalidError, orderRepository } from './order-service';

export const orderRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext): OrderRepository {
  return orderRepository(context.env, context.get('authToken'));
}

function toListItem(record: OrderRecord): OrderListItem {
  return {
    id: record.id,
    orderNumber: record.orderNumber,
    customerId: record.customerId,
    customerName: record.customerName,
    orderType: record.orderType,
    status: record.status,
    ...(record.routeName ? { routeName: record.routeName } : {}),
    ...(record.departureDate ? { departureDate: record.departureDate } : {}),
    ...(record.returnDate ? { returnDate: record.returnDate } : {}),
    adultCount: record.adultCount,
    childCount: record.childCount,
    personCount: record.personCount,
    receivableTotal: record.receivableTotal,
    payableTotal: record.payableTotal,
    profit: record.profit,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toDetail(record: OrderRecord): OrderDetail {
  return {
    ...toListItem(record),
    ...(record.remark ? { remark: record.remark } : {}),
    ...(record.statusReason ? { statusReason: record.statusReason } : {}),
    receivables: record.receivables,
    payables: record.payables,
    version: record.version,
  };
}

/** 乐观结果 → HTTP。状态冲突与版本冲突都是 409，但错误码必须区分，前端处理方式不同。 */
function mutationError(errorCode: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'ORDER_STATE_CONFLICT') {
  if (errorCode === 'ORDER_STATE_CONFLICT') {
    return new ApiHttpError(
      409,
      ERROR_CODES.ORDER_STATE_CONFLICT,
      'The order status does not allow this action',
    );
  }
  if (errorCode === 'VERSION_CONFLICT') {
    return new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The order was modified by another user');
  }
  return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Order not found');
}

orderRoutes.get(
  ROUTES.listOrders.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const query = parseQuery(context, orderListQuerySchema);
    const auth = context.get('auth');
    const page = await repository(context).list({
      organizationId: auth.organizationId,
      keyword: query.keyword,
      status: query.status,
      orderType: query.orderType,
      customerId: query.customerId,
      departureFrom: query.departureFrom,
      departureTo: query.departureTo,
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
      ownerUserId: auth.dataScope === 'own' ? auth.userId : undefined,
    });
    return respond(context, 'listOrders', {
      items: page.items.map(toListItem),
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

orderRoutes.post(
  ROUTES.createOrder.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const input = await parseJson(context, createOrderRequestSchema);
    const auth = context.get('auth');
    const order = await repository(context)
      .create(auth.organizationId, {
        customerId: input.customerId,
        orderType: input.orderType,
        routeName: input.routeName,
        departureDate: input.departureDate,
        returnDate: input.returnDate,
        adultCount: input.adultCount,
        childCount: input.childCount,
        receivables: input.receivables,
        payables: input.payables,
        remark: input.remark,
      })
      .catch((cause) => {
        if (cause instanceof OrderCustomerInvalidError) {
          throw new ApiHttpError(
            400,
            ERROR_CODES.VALIDATION_ERROR,
            'The customer or supplier does not belong to this organization',
          );
        }
        throw cause;
      });
    return respond(context, 'createOrder', { order: toDetail(order) }, 201);
  },
);

orderRoutes.get(
  ROUTES.getOrder.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const { orderId } = parseParams(context, orderParamsSchema);
    const order = await repository(context).findById(context.get('auth').organizationId, orderId);
    if (!order) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Order not found');
    return respond(context, 'getOrder', { order: toDetail(order) });
  },
);

orderRoutes.patch(
  ROUTES.updateOrder.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const { orderId } = parseParams(context, orderParamsSchema);
    const body = await parseJson(context, updateOrderRequestSchema);
    const result = await repository(context)
      .update(context.get('auth').organizationId, orderId, body.version, {
        customerId: body.customerId,
        orderType: body.orderType,
        routeName: body.routeName,
        departureDate: body.departureDate,
        returnDate: body.returnDate,
        adultCount: body.adultCount,
        childCount: body.childCount,
        receivables: body.receivables,
        payables: body.payables,
        remark: body.remark,
      })
      .catch((cause) => {
        if (cause instanceof OrderCustomerInvalidError) {
          throw new ApiHttpError(
            400,
            ERROR_CODES.VALIDATION_ERROR,
            'The customer or supplier does not belong to this organization',
          );
        }
        throw cause;
      });
    if (!result.ok) throw mutationError(result.errorCode);
    return respond(context, 'updateOrder', { order: toDetail(result.order) });
  },
);

orderRoutes.post(
  ROUTES.transitionOrder.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const { orderId } = parseParams(context, orderParamsSchema);
    const body = await parseJson(context, transitionOrderRequestSchema);
    const result = await repository(context).transition(
      context.get('auth').organizationId,
      orderId,
      body.version,
      body.action,
      body.reason,
    );
    if (!result.ok) throw mutationError(result.errorCode);
    return respond(context, 'transitionOrder', { order: toDetail(result.order) });
  },
);
