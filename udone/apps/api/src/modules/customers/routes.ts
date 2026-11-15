import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  createCustomerRequestSchema,
  createCustomerSourceRequestSchema,
  createCustomerTagRequestSchema,
  customerListQuerySchema,
  customerParamsSchema,
  customerRecycleBinQuerySchema,
  customerSourceParamsSchema,
  updateCustomerRequestSchema,
  updateCustomerSourceRequestSchema,
} from '@erp/contracts';
import type { CustomerDetail, CustomerListItem } from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import type { CustomerRecord, CustomerRepository } from './customer-service';
import {
  CustomerConflictError,
  CustomerSourceConflictError,
  CustomerTagConflictError,
  CustomerTagInvalidError,
  customerRepository,
  maskEmail,
  maskIdNumber,
  maskPhone,
} from './customer-service';

export const customerRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext): CustomerRepository {
  return customerRepository(context.env, context.get('authToken'));
}

/** 电话/证件原值只对持有 `customer.sensitive.read` 的角色返回，其余一律只给掩码。 */
function canReadSensitive(context: ApiContext): boolean {
  return context.get('auth').permissions.includes(PERMISSIONS.CUSTOMER_SENSITIVE_READ);
}

function toDetail(record: CustomerRecord, sensitive: boolean): CustomerDetail {
  return {
    id: record.id,
    name: record.name,
    ...(sensitive && record.phone ? { phone: record.phone } : {}),
    ...(record.phone ? { phoneMasked: maskPhone(record.phone) } : {}),
    ...(sensitive && record.email ? { email: record.email } : {}),
    ...(record.email ? { emailMasked: maskEmail(record.email) } : {}),
    ...(record.idType ? { idType: record.idType } : {}),
    ...(sensitive && record.idNumber ? { idNumber: record.idNumber } : {}),
    ...(record.idNumber ? { idNumberMasked: maskIdNumber(record.idNumber) } : {}),
    ...(record.birthday ? { birthday: record.birthday } : {}),
    ...(record.sourceId ? { sourceId: record.sourceId } : {}),
    ...(record.sourceName ? { sourceName: record.sourceName } : {}),
    tags: record.tags,
    ...(record.remark ? { remark: record.remark } : {}),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toListItem(record: CustomerRecord): CustomerListItem {
  return {
    id: record.id,
    name: record.name,
    ...(record.phone ? { phoneMasked: maskPhone(record.phone) } : {}),
    ...(record.email ? { emailMasked: maskEmail(record.email) } : {}),
    ...(record.sourceName ? { sourceName: record.sourceName } : {}),
    tags: record.tags,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** 领域错误 → 契约错误码。未识别的错误原样抛出，交给全局错误处理。 */
function customerError(cause: unknown): unknown {
  if (cause instanceof CustomerTagInvalidError) {
    return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'One or more tags are invalid', {
      invalidTagIds: cause.tagIds,
    });
  }
  if (cause instanceof CustomerConflictError) {
    return new ApiHttpError(
      409,
      ERROR_CODES.CONFLICT,
      'The customer conflicts with an existing record',
    );
  }
  if (cause instanceof CustomerTagConflictError) {
    return new ApiHttpError(409, ERROR_CODES.CONFLICT, 'A tag with this name already exists');
  }
  if (cause instanceof CustomerSourceConflictError) {
    return new ApiHttpError(
      409,
      ERROR_CODES.CONFLICT,
      'A source with this name already exists at this level',
    );
  }
  return cause;
}

customerRoutes.get(
  ROUTES.listCustomers.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_READ),
  async (context) => {
    const query = parseQuery(context, customerListQuerySchema);
    const auth = context.get('auth');
    const page = await repository(context).list({
      organizationId: auth.organizationId,
      keyword: query.keyword,
      sourceId: query.sourceId,
      tagId: query.tagId,
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
      ownerUserId: auth.dataScope === 'own' ? auth.userId : undefined,
    });
    return respond(context, 'listCustomers', {
      items: page.items.map(toListItem),
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

customerRoutes.post(
  ROUTES.createCustomer.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_WRITE),
  async (context) => {
    const input = await parseJson(context, createCustomerRequestSchema);
    const auth = context.get('auth');
    const repo = repository(context);
    if (input.tagIds && input.tagIds.length > 0) {
      await repo
        .assertTagsBelongToOrganization(auth.organizationId, input.tagIds)
        .catch((cause) => {
          throw customerError(cause);
        });
    }

    const customer = await repo
      .create({ organizationId: auth.organizationId, ...input })
      .catch((cause) => {
        throw customerError(cause);
      });

    // 同手机号只做提示，不阻断创建（R-CUSTOMER-01）。刚创建的这条本身也在结果里，需排除。
    const duplicates = input.phone
      ? (await repo.findDuplicatesByPhone(auth.organizationId, input.phone)).filter(
          (record) => record.id !== customer.id,
        )
      : [];

    return respond(
      context,
      'createCustomer',
      {
        customer: toDetail(customer, canReadSensitive(context)),
        duplicates: duplicates.map((record) => ({
          id: record.id,
          name: record.name,
          ...(record.phone ? { phoneMasked: maskPhone(record.phone) } : {}),
          createdAt: record.createdAt,
        })),
      },
      201,
    );
  },
);

/**
 * 回收站列表。
 *
 * 权限用 `customer.restore` 而不是 `customer.read`：能读已删除数据与能恢复是同一种能力，
 * 拆开只会多一条没有界面管控的读通道（正是 `20261029000004` 注释里说的口径）。
 *
 * 这条路由必须在 `/api/customers/:customerId` 之前注册，否则 `recycle-bin` 会被当成 ID。
 */
customerRoutes.get(
  ROUTES.listDeletedCustomers.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_RESTORE),
  async (context) => {
    const query = parseQuery(context, customerRecycleBinQuerySchema);
    const auth = context.get('auth');
    const page = await repository(context).listDeleted({
      organizationId: auth.organizationId,
      keyword: query.keyword,
      page: query.page,
      pageSize: query.pageSize,
    });
    return respond(context, 'listDeletedCustomers', {
      items: page.items.map((record) => ({
        id: record.id,
        name: record.name,
        ...(record.phone ? { phoneMasked: maskPhone(record.phone) } : {}),
        ...(record.email ? { emailMasked: maskEmail(record.email) } : {}),
        ...(record.sourceName ? { sourceName: record.sourceName } : {}),
        tags: record.tags,
        createdAt: record.createdAt,
        deletedAt: record.deletedAt,
      })),
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

customerRoutes.get(
  ROUTES.getCustomer.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_READ),
  async (context) => {
    const { customerId } = parseParams(context, customerParamsSchema);
    const customer = await repository(context).findById(
      context.get('auth').organizationId,
      customerId,
    );
    if (!customer) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Customer not found');
    }
    return respond(context, 'getCustomer', {
      customer: toDetail(customer, canReadSensitive(context)),
    });
  },
);

customerRoutes.patch(
  ROUTES.updateCustomer.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_WRITE),
  async (context) => {
    const { customerId } = parseParams(context, customerParamsSchema);
    const body = await parseJson(context, updateCustomerRequestSchema);
    const auth = context.get('auth');
    const repo = repository(context);

    const existing = await repo.findById(auth.organizationId, customerId);
    if (!existing) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Customer not found');
    }
    // 版本不符说明别人已改过，必须让操作者重新读取后再提交，不能静默覆盖。
    if (existing.version !== body.version) {
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The customer was modified by another user',
      );
    }
    if (body.tagIds && body.tagIds.length > 0) {
      await repo.assertTagsBelongToOrganization(auth.organizationId, body.tagIds).catch((cause) => {
        throw customerError(cause);
      });
    }

    // `version` 只用于乐观锁比较，不能进 patch 否则会被当成待更新字段再写一次。
    const patch = {
      name: body.name,
      phone: body.phone,
      email: body.email,
      idType: body.idType,
      idNumber: body.idNumber,
      birthday: body.birthday,
      sourceId: body.sourceId,
      tagIds: body.tagIds,
      remark: body.remark,
    };
    const updated = await repo
      .update(auth.organizationId, customerId, body.version, patch)
      .catch((cause) => {
        throw customerError(cause);
      });
    if (!updated) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Customer not found');
    }
    return respond(context, 'updateCustomer', {
      customer: toDetail(updated, canReadSensitive(context)),
    });
  },
);

customerRoutes.delete(
  ROUTES.deleteCustomer.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_WRITE),
  async (context) => {
    const { customerId } = parseParams(context, customerParamsSchema);
    const auth = context.get('auth');
    const deleted = await repository(context).softDelete(
      auth.organizationId,
      customerId,
      auth.userId,
    );
    if (!deleted) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Customer not found');
    }
    return respond(context, 'deleteCustomer', { deletedCustomerId: customerId });
  },
);

customerRoutes.post(
  ROUTES.restoreCustomer.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_RESTORE),
  async (context) => {
    const { customerId } = parseParams(context, customerParamsSchema);
    const auth = context.get('auth');
    const restored = await repository(context).restore(auth.organizationId, customerId);
    if (!restored) {
      // 不在回收站里（没删过 / 不存在 / 属于别的组织）一律 404：
      // 区分这三种情况等于告诉调用方「这个 ID 是否存在」，而它本来就读不到。
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Customer is not in the recycle bin');
    }
    return respond(context, 'restoreCustomer', { restoredCustomerId: customerId });
  },
);

customerRoutes.get(
  ROUTES.listCustomerTags.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_READ),
  async (context) => {
    const tags = await repository(context).listTags(context.get('auth').organizationId);
    return respond(context, 'listCustomerTags', { tags });
  },
);

customerRoutes.post(
  ROUTES.createCustomerTag.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_WRITE),
  async (context) => {
    const input = await parseJson(context, createCustomerTagRequestSchema);
    const tag = await repository(context)
      .createTag(context.get('auth').organizationId, input.name, input.color)
      .catch((cause) => {
        throw customerError(cause);
      });
    return respond(context, 'createCustomerTag', { tag }, 201);
  },
);

/* --------------------------------------------------------- 来源主数据 */

customerRoutes.get(
  ROUTES.listCustomerSources.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_READ),
  async (context) => {
    // `includeInactive=1` 给管理页用；客户表单只要启用的，所以默认不含停用项。
    const includeInactive = context.req.query('includeInactive') === '1';
    const sources = await repository(context).listSources(
      context.get('auth').organizationId,
      includeInactive,
    );
    return respond(context, 'listCustomerSources', { sources });
  },
);

customerRoutes.post(
  ROUTES.createCustomerSource.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_WRITE),
  async (context) => {
    const input = await parseJson(context, createCustomerSourceRequestSchema);
    const source = await repository(context)
      .createSource({
        organizationId: context.get('auth').organizationId,
        name: input.name,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder,
      })
      .catch((cause) => {
        throw customerError(cause);
      });
    return respond(context, 'createCustomerSource', { source }, 201);
  },
);

customerRoutes.patch(
  ROUTES.updateCustomerSource.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_WRITE),
  async (context) => {
    const { sourceId } = parseParams(context, customerSourceParamsSchema);
    const input = await parseJson(context, updateCustomerSourceRequestSchema);
    const source = await repository(context)
      .updateSource(context.get('auth').organizationId, sourceId, input)
      .catch((cause) => {
        throw customerError(cause);
      });
    if (!source) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Source not found');
    }
    return respond(context, 'updateCustomerSource', { source });
  },
);

customerRoutes.delete(
  ROUTES.deleteCustomerSource.path,
  requireAuth(),
  requirePermission(PERMISSIONS.CUSTOMER_WRITE),
  async (context) => {
    const { sourceId } = parseParams(context, customerSourceParamsSchema);
    const result = await repository(context).deleteSource(
      context.get('auth').organizationId,
      sourceId,
    );
    if (result === 'not_found') {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Source not found');
    }
    if (result === 'in_use') {
      // 409 而不是 400：请求本身合法，是当前数据状态不允许。
      // 文案要让人知道「该先做什么」，否则用户只会反复点删除。
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'Source is used by customers or has child sources',
      );
    }
    return respond(context, 'deleteCustomerSource', { deletedSourceId: sourceId });
  },
);
