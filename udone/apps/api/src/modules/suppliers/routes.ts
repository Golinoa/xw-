import { Hono } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  createSupplierRequestSchema,
  supplierListQuerySchema,
} from '@erp/contracts';
import { parseJson, parseQuery, respond } from '../../lib/contract';
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
