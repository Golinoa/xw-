import { Hono } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  createSupplierRequestSchema,
  supplierListQuerySchema,
  supplierParamsSchema,
  updateSupplierRequestSchema,
} from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { SupplierNameConflictError, supplierRepository } from './supplier-service';

export const supplierRoutes = new Hono<ApiEnvironment>();

supplierRoutes.get(
  ROUTES.listSuppliers.path,
  requireAuth(),
  requirePermission(PERMISSIONS.SUPPLIER_READ),
  async (context) => {
    const query = parseQuery(context, supplierListQuerySchema);
    const page = await supplierRepository(context.env, context.get('authToken')).list({
      organizationId: context.get('auth').organizationId,
      keyword: query.keyword,
      settlement: query.settlement,
      activeOnly: query.activeOnly !== 'false',
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });
    return respond(context, 'listSuppliers', {
      items: page.items,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

supplierRoutes.post(
  ROUTES.createSupplier.path,
  requireAuth(),
  requirePermission(PERMISSIONS.SUPPLIER_WRITE),
  async (context) => {
    const input = await parseJson(context, createSupplierRequestSchema);
    const supplier = await supplierRepository(context.env, context.get('authToken'))
      .create(context.get('auth').organizationId, input)
      .catch((cause) => {
        if (cause instanceof SupplierNameConflictError) {
          throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'A supplier with this name exists');
        }
        throw cause;
      });
    return respond(context, 'createSupplier', { supplier }, 201);
  },
);

supplierRoutes.patch(
  ROUTES.updateSupplier.path,
  requireAuth(),
  requirePermission(PERMISSIONS.SUPPLIER_WRITE),
  async (context) => {
    const { supplierId } = parseParams(context, supplierParamsSchema);
    const input = await parseJson(context, updateSupplierRequestSchema);
    const supplier = await supplierRepository(context.env, context.get('authToken'))
      .update(context.get('auth').organizationId, supplierId, input)
      .catch((cause) => {
        if (cause instanceof SupplierNameConflictError) {
          throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'A supplier with this name exists');
        }
        throw cause;
      });
    if (supplier === 'not_found') {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Supplier not found');
    }
    return respond(context, 'updateSupplier', { supplier });
  },
);

supplierRoutes.delete(
  ROUTES.deleteSupplier.path,
  requireAuth(),
  requirePermission(PERMISSIONS.SUPPLIER_WRITE),
  async (context) => {
    const { supplierId } = parseParams(context, supplierParamsSchema);
    const result = await supplierRepository(context.env, context.get('authToken')).delete(
      context.get('auth').organizationId,
      supplierId,
    );
    if (result === 'not_found') {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Supplier not found');
    }
    if (result === 'in_use') {
      // 409 OBJECT_REFERENCED 而不是 CONFLICT：调用方要靠这个码区分
      // 「名字撞了」和「被引用了」，两者给人的下一步完全不同。
      throw new ApiHttpError(
        409,
        ERROR_CODES.OBJECT_REFERENCED,
        'Supplier is referenced by payable lines',
      );
    }
    return respond(context, 'deleteSupplier', { deletedSupplierId: supplierId });
  },
);
