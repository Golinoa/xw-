import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  createTouristRequestSchema,
  orderTouristParamsSchema,
  touristImportRequestSchema,
  touristParamsSchema,
  updateTouristRequestSchema,
} from '@erp/contracts';
import type {
  Tourist,
  TouristImportError,
  TouristImportMode,
  TouristImportPreview,
  TouristRoster,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../../lib/contract';
import { RestRequestError } from '../../lib/rest-client';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { maskIdNumber, maskPhone } from '../customers/customer-service';
import {
  TOURIST_CSV_TEMPLATE,
  TOURIST_IMPORT_MAX_ROWS,
  findBatchDuplicates,
  normalizeDocumentNumber,
  parseTouristCsv,
} from './tourist-csv';
import type { ParsedTouristRow } from './tourist-csv';
import type { TouristRecord, TouristRepository } from './tourist-service';
import { TouristDocumentConflictError, touristRepository } from './tourist-service';

/**
 * 游客名单（R-TOURIST-01）。
 *
 * 权限复用订单的 `order.read` / `order.write`：名单是订单聚合的一部分，
 * 「能看这张单」就该能看它的名单。库层面的可见性也继承订单（见迁移里的策略）。
 *
 * 证件号与手机默认只下发掩码，持有 `customer.sensitive.read` 的角色才拿到原值。
 * 这份掩码规则与客户模块共用同一实现，不另写一份——两处算法一旦分叉，
 * 就会出现「同一个人的证件号在客户页看得到、在名单里看不到」。
 */
export const touristRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext): TouristRepository {
  return touristRepository(context.env, context.get('authToken'));
}

function canReadSensitive(context: ApiContext): boolean {
  return context.get('auth').permissions.includes(PERMISSIONS.CUSTOMER_SENSITIVE_READ);
}

function toApiTourist(record: TouristRecord, sensitive: boolean): Tourist {
  return {
    id: record.id,
    name: record.name,
    ...(record.phone ? { phoneMasked: maskPhone(record.phone) } : {}),
    ...(sensitive && record.phone ? { phone: record.phone } : {}),
    ...(record.documentType ? { documentType: record.documentType } : {}),
    ...(record.documentNumber ? { documentNumberMasked: maskIdNumber(record.documentNumber) } : {}),
    ...(sensitive && record.documentNumber ? { documentNumber: record.documentNumber } : {}),
    personType: record.personType,
    ...(record.age === undefined ? {} : { age: record.age }),
    gender: record.gender,
    ...(record.remark ? { remark: record.remark } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function countPeople(rows: ReadonlyArray<{ personType: string }>): {
  adultCount: number;
  childCount: number;
} {
  let adultCount = 0;
  let childCount = 0;
  for (const row of rows) {
    if (row.personType === 'adult') adultCount += 1;
    else childCount += 1;
  }
  return { adultCount, childCount };
}

function toRoster(
  items: readonly TouristRecord[],
  declared: { adultCount: number; childCount: number },
  sensitive: boolean,
): TouristRoster {
  const counts = countPeople(items);
  return {
    items: items.map((item) => toApiTourist(item, sensitive)),
    total: items.length,
    adultCount: counts.adultCount,
    childCount: counts.childCount,
    personCount: items.length,
    declaredAdultCount: declared.adultCount,
    declaredChildCount: declared.childCount,
  };
}

/** 证件号在预览里也只给掩码：预览是给人看的，不需要把号码再抄一遍。 */
function toPreviewRow(row: ParsedTouristRow) {
  return {
    line: row.line,
    name: row.name,
    ...(row.phone ? { phoneMasked: maskPhone(row.phone) } : {}),
    ...(row.documentType ? { documentType: row.documentType } : {}),
    ...(row.documentNumber ? { documentNumberMasked: maskIdNumber(row.documentNumber) } : {}),
    personType: row.personType,
    ...(row.age === undefined ? {} : { age: row.age }),
    gender: row.gender,
    ...(row.remark ? { remark: row.remark } : {}),
  };
}

/**
 * 与名单里已有的人撞证件。
 *
 * 只在追加模式下有意义：覆盖模式会先清空名单，现有证件不会留下。
 */
function findExistingDuplicates(
  rows: readonly ParsedTouristRow[],
  existing: ReadonlyArray<{
    name: string;
    documentType: string;
    normalizedDocumentNumber: string;
  }>,
): TouristImportError[] {
  const byKey = new Map(
    existing.map((item) => [`${item.documentType}:${item.normalizedDocumentNumber}`, item.name]),
  );
  const errors: TouristImportError[] = [];
  for (const row of rows) {
    const normalized = normalizeDocumentNumber(row.documentNumber);
    if (!normalized || !row.documentType) continue;
    const name = byKey.get(`${row.documentType}:${normalized}`);
    if (name) {
      errors.push({ line: row.line, message: `与名单中已有的「${name}」是同一个证件` });
    }
  }
  return errors;
}

interface ValidatedImport {
  rows: ParsedTouristRow[];
  totalRows: number;
  errors: TouristImportError[];
  /** 格式错误与重复分开：前者 400，后者 409，前端提示语不同。 */
  validationErrors: TouristImportError[];
  duplicateErrors: TouristImportError[];
  /** 导入后名单会长成什么样（供差额提示；有错误时只是参考值）。 */
  summary: TouristImportPreview['summary'];
}

/**
 * 一次校验，两处使用（预览与提交）。
 *
 * 提交时再算一遍是刻意的：预览只把结果展示给用户，真正的写入口不能信任
 * 「前端已经校验过」。两次调用的参数完全相同，因此结果也相同。
 */
async function validateImport(
  repo: TouristRepository,
  organizationId: string,
  orderId: string,
  csv: string,
  mode: TouristImportMode,
): Promise<ValidatedImport | null> {
  const roster = await repo.readRoster(organizationId, orderId);
  if (!roster) return null;

  const parsed = parseTouristCsv(csv);
  const batchDuplicates = findBatchDuplicates(parsed.rows);
  const existing = mode === 'append' ? await repo.listDocuments(organizationId, orderId) : [];
  const existingDuplicates = mode === 'append' ? findExistingDuplicates(parsed.rows, existing) : [];

  // 格式错误与重复都可能落在同一行，合并后按行号排序，用户从上往下改即可。
  const duplicateLines = new Set([...batchDuplicates, ...existingDuplicates].map((e) => e.line));
  const validationErrors = parsed.errors.filter((error) => !duplicateLines.has(error.line));
  const duplicateErrors = [...batchDuplicates, ...existingDuplicates].sort(
    (left, right) => left.line - right.line,
  );

  const prospects =
    mode === 'append'
      ? [...roster.items.map((item) => ({ personType: item.personType })), ...parsed.rows]
      : parsed.rows;
  const counts = countPeople(prospects);

  return {
    rows: parsed.rows,
    totalRows: parsed.totalRows,
    errors: [...validationErrors, ...duplicateErrors].sort((left, right) => left.line - right.line),
    validationErrors,
    duplicateErrors,
    summary: {
      adultCount: counts.adultCount,
      childCount: counts.childCount,
      personCount: prospects.length,
      declaredAdultCount: roster.declared.adultCount,
      declaredChildCount: roster.declared.childCount,
    },
  };
}

function notFound(): never {
  throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Order not found');
}

touristRoutes.get(
  ROUTES.listTourists.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const { orderId } = parseParams(context, orderTouristParamsSchema);
    const organizationId = context.get('auth').organizationId;
    const result = await repository(context).readRoster(organizationId, orderId);
    if (!result) notFound();
    return respond(context, 'listTourists', {
      roster: toRoster(result.items, result.declared, canReadSensitive(context)),
    });
  },
);

touristRoutes.post(
  ROUTES.createTourist.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const { orderId } = parseParams(context, orderTouristParamsSchema);
    const input = await parseJson(context, createTouristRequestSchema);
    const organizationId = context.get('auth').organizationId;
    try {
      const created = await repository(context).create(organizationId, orderId, input);
      return respond(
        context,
        'createTourist',
        { tourist: toApiTourist(created, canReadSensitive(context)) },
        201,
      );
    } catch (cause) {
      if (cause instanceof TouristDocumentConflictError) {
        throw new ApiHttpError(
          409,
          ERROR_CODES.TOURIST_DOCUMENT_CONFLICT,
          'The document number already exists in this order',
        );
      }
      throw cause;
    }
  },
);

touristRoutes.patch(
  ROUTES.updateTourist.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const { orderId, touristId } = parseParams(context, touristParamsSchema);
    const input = await parseJson(context, updateTouristRequestSchema);
    const organizationId = context.get('auth').organizationId;
    try {
      const updated = await repository(context).update(organizationId, orderId, touristId, input);
      if (!updated) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Tourist not found');
      return respond(context, 'updateTourist', {
        tourist: toApiTourist(updated, canReadSensitive(context)),
      });
    } catch (cause) {
      if (cause instanceof TouristDocumentConflictError) {
        throw new ApiHttpError(
          409,
          ERROR_CODES.TOURIST_DOCUMENT_CONFLICT,
          'The document number already exists in this order',
        );
      }
      throw cause;
    }
  },
);

touristRoutes.delete(
  ROUTES.deleteTourist.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const { orderId, touristId } = parseParams(context, touristParamsSchema);
    const organizationId = context.get('auth').organizationId;
    const deleted = await repository(context).remove(organizationId, orderId, touristId);
    if (!deleted) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Tourist not found');
    return respond(context, 'deleteTourist', { deletedTouristId: touristId });
  },
);

touristRoutes.post(
  ROUTES.previewTouristImport.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const { orderId } = parseParams(context, orderTouristParamsSchema);
    const input = await parseJson(context, touristImportRequestSchema);
    const organizationId = context.get('auth').organizationId;
    const result = await validateImport(
      repository(context),
      organizationId,
      orderId,
      input.csv,
      input.mode,
    );
    if (!result) notFound();
    return respond(context, 'previewTouristImport', {
      totalRows: result.totalRows,
      validRows: result.rows.length,
      invalidRows: result.totalRows - result.rows.length,
      rows: result.rows.map(toPreviewRow),
      errors: result.errors,
      summary: result.summary,
    });
  },
);

touristRoutes.post(
  ROUTES.importTourists.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_WRITE),
  async (context) => {
    const { orderId } = parseParams(context, orderTouristParamsSchema);
    const input = await parseJson(context, touristImportRequestSchema);
    const organizationId = context.get('auth').organizationId;
    const repo = repository(context);
    const result = await validateImport(repo, organizationId, orderId, input.csv, input.mode);
    if (!result) notFound();

    // 整批拒绝：格式错误优先（改文件），重复其次（改数据或改模式）。
    if (result.validationErrors.length > 0) {
      throw new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'The CSV file contains invalid rows',
        { errors: result.errors, maxRows: TOURIST_IMPORT_MAX_ROWS },
      );
    }
    if (result.duplicateErrors.length > 0) {
      throw new ApiHttpError(
        409,
        ERROR_CODES.TOURIST_DOCUMENT_CONFLICT,
        'The CSV file contains tourists already in the roster',
        { errors: result.errors },
      );
    }
    if (result.rows.length === 0) {
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The CSV file has no data rows');
    }

    try {
      const written = await repo.importRows(organizationId, orderId, input.mode, result.rows);
      return respond(context, 'importTourists', written);
    } catch (cause) {
      // 库函数在订单不可见时抛 P0002，PostgREST 映射成 404；把它翻成业务 404。
      if (cause instanceof RestRequestError && cause.status === 404) notFound();
      if (cause instanceof RestRequestError && cause.status === 409) {
        throw new ApiHttpError(
          409,
          ERROR_CODES.TOURIST_DOCUMENT_CONFLICT,
          'The document number already exists in this order',
        );
      }
      throw cause;
    }
  },
);

touristRoutes.get(ROUTES.getTouristImportTemplate.path, requireAuth(), async (context) =>
  respond(context, 'getTouristImportTemplate', {
    filename: '游客名单导入模板.csv',
    content: TOURIST_CSV_TEMPLATE,
  }),
);
