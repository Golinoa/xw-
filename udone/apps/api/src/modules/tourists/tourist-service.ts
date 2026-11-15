import type {
  TouristDocumentType,
  TouristGender,
  TouristImportMode,
  TouristPersonType,
} from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { RestConflictError, createRestClient } from '../../lib/rest-client';
import type { ParsedTouristRow } from './tourist-csv';

/**
 * 游客名单仓储（R-TOURIST-01）。
 *
 * 只有一处写路径值得单独说明：CSV 导入走 `rpc/import_tourists` 而不是
 * 「先 DELETE 再 POST 一批」。覆盖模式的两次调用之间如果进程被回收，
 * 用户的名单就没了；库函数的函数体是一个事务，一行出错整批回滚。
 */

const COLUMNS =
  'id,name,phone,document_type,document_number,person_type,age,gender,remark,created_at,updated_at';

const DOCUMENT_COLUMNS = 'name,document_type,normalized_document_number';

type TouristRow = {
  id: string;
  name: string;
  phone: string | null;
  document_type: string | null;
  document_number: string | null;
  person_type: string;
  age: number | null;
  gender: string;
  remark: string | null;
  created_at: string;
  updated_at: string;
};

export interface TouristRecord {
  id: string;
  name: string;
  phone?: string;
  documentType?: TouristDocumentType;
  documentNumber?: string;
  personType: TouristPersonType;
  age?: number;
  gender: TouristGender;
  remark?: string;
  createdAt: string;
  updatedAt: string;
}

/** 订单的申报人数：名单与它对不上只警告，但它必须来自订单本身。 */
export interface DeclaredCounts {
  adultCount: number;
  childCount: number;
}

export interface TouristCreateInput {
  name: string;
  phone?: string | null;
  documentType?: TouristDocumentType | null;
  documentNumber?: string | null;
  personType: TouristPersonType;
  age?: number | null;
  gender?: TouristGender;
  remark?: string | null;
}

export interface TouristUpdateInput {
  name?: string;
  phone?: string | null;
  documentType?: TouristDocumentType | null;
  documentNumber?: string | null;
  personType?: TouristPersonType;
  age?: number | null;
  gender?: TouristGender;
  remark?: string | null;
}

/** 已存在的证件：用于导入前的重复预检。规范化值由数据库生成列给出。 */
export interface ExistingDocument {
  name: string;
  documentType: TouristDocumentType;
  normalizedDocumentNumber: string;
}

export interface TouristRepository {
  /** 返回 null 表示订单不可见（不存在、不是本组织、不在数据范围内）。 */
  readRoster(
    organizationId: string,
    orderId: string,
  ): Promise<{ items: TouristRecord[]; declared: DeclaredCounts } | null>;
  create(
    organizationId: string,
    orderId: string,
    input: TouristCreateInput,
  ): Promise<TouristRecord>;
  update(
    organizationId: string,
    orderId: string,
    touristId: string,
    patch: TouristUpdateInput,
  ): Promise<TouristRecord | null>;
  remove(organizationId: string, orderId: string, touristId: string): Promise<boolean>;
  listDocuments(organizationId: string, orderId: string): Promise<ExistingDocument[]>;
  importRows(
    organizationId: string,
    orderId: string,
    mode: TouristImportMode,
    rows: readonly ParsedTouristRow[],
  ): Promise<{ inserted: number; deleted: number }>;
}

/** 同订单内证件重复。服务层据此返回 `TOURIST_DOCUMENT_CONFLICT`。 */
export class TouristDocumentConflictError extends Error {
  constructor() {
    super('A tourist with this document already exists in the order');
    this.name = 'TouristDocumentConflictError';
  }
}

function optional(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

function toRecord(row: TouristRow): TouristRecord {
  return {
    id: row.id,
    name: row.name,
    phone: optional(row.phone),
    documentType: (row.document_type ?? undefined) as TouristDocumentType | undefined,
    documentNumber: optional(row.document_number),
    personType: row.person_type as TouristPersonType,
    age: row.age ?? undefined,
    gender: row.gender as TouristGender,
    remark: optional(row.remark),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSupabaseTouristRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): TouristRepository {
  const client = createRestClient(environment, token);

  function orderFilter(organizationId: string, orderId: string): string {
    return `organization_id=eq.${encodeURIComponent(organizationId)}&order_id=eq.${encodeURIComponent(orderId)}`;
  }

  return {
    async readRoster(organizationId, orderId) {
      // 先读订单：读不到就没有名单可谈。这一步同时是 404 与「越权」的同一条路径，
      // 因为订单的 RLS 已经按组织、权限、数据范围、软删除过滤过了。
      const orders = await client.rest<Array<{ adult_count: number; child_count: number }>>(
        `orders?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(orderId)}&select=adult_count,child_count`,
        { organizationId },
      );
      const order = orders[0];
      if (!order) return null;

      const rows = await client.rest<TouristRow[]>(
        `tourists?${orderFilter(organizationId, orderId)}&select=${COLUMNS}&order=created_at.asc`,
        { organizationId },
      );
      return {
        items: rows.map(toRecord),
        declared: { adultCount: order.adult_count, childCount: order.child_count },
      };
    },

    async create(organizationId, orderId, input) {
      try {
        const rows = await client.rest<TouristRow[]>('tourists', {
          method: 'POST',
          organizationId,
          headers: { Prefer: 'return=representation' },
          body: {
            organization_id: organizationId,
            order_id: orderId,
            name: input.name,
            phone: input.phone ?? null,
            document_type: input.documentType ?? null,
            document_number: input.documentNumber ?? null,
            person_type: input.personType,
            age: input.age ?? null,
            gender: input.gender ?? 'unknown',
            remark: input.remark ?? null,
          },
        });
        const row = rows[0];
        if (!row) throw new Error('Tourist creation returned no row');
        return toRecord(row);
      } catch (cause) {
        if (cause instanceof RestConflictError) throw new TouristDocumentConflictError();
        throw cause;
      }
    },

    async update(organizationId, orderId, touristId, patch) {
      const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.phone !== undefined) body.phone = patch.phone;
      if (patch.documentType !== undefined) body.document_type = patch.documentType;
      if (patch.documentNumber !== undefined) body.document_number = patch.documentNumber;
      if (patch.personType !== undefined) body.person_type = patch.personType;
      if (patch.age !== undefined) body.age = patch.age;
      if (patch.gender !== undefined) body.gender = patch.gender;
      if (patch.remark !== undefined) body.remark = patch.remark;

      try {
        const rows = await client.rest<TouristRow[]>(
          `tourists?${orderFilter(organizationId, orderId)}&id=eq.${encodeURIComponent(touristId)}`,
          {
            method: 'PATCH',
            organizationId,
            headers: { Prefer: 'return=representation' },
            body,
          },
        );
        const row = rows[0];
        return row ? toRecord(row) : null;
      } catch (cause) {
        if (cause instanceof RestConflictError) throw new TouristDocumentConflictError();
        throw cause;
      }
    },

    async remove(organizationId, orderId, touristId) {
      const rows = await client.rest<Array<{ id: string }>>(
        `tourists?${orderFilter(organizationId, orderId)}&id=eq.${encodeURIComponent(touristId)}`,
        {
          method: 'DELETE',
          organizationId,
          headers: { Prefer: 'return=representation' },
        },
      );
      return rows.length > 0;
    },

    async listDocuments(organizationId, orderId) {
      const rows = await client.rest<
        Array<{ name: string; document_type: string; normalized_document_number: string }>
      >(
        `tourists?${orderFilter(organizationId, orderId)}&select=${DOCUMENT_COLUMNS}&normalized_document_number=not.is.null`,
        { organizationId },
      );
      return rows.map((row) => ({
        name: row.name,
        documentType: row.document_type as TouristDocumentType,
        normalizedDocumentNumber: row.normalized_document_number,
      }));
    },

    async importRows(organizationId, orderId, mode, rows) {
      const result = await client.rest<Array<{ inserted_count: number; deleted_count: number }>>(
        'rpc/import_tourists',
        {
          method: 'POST',
          organizationId,
          body: {
            requested_order_id: orderId,
            requested_mode: mode,
            requested_rows: rows.map((row) => ({
              name: row.name,
              phone: row.phone ?? null,
              document_type: row.documentType ?? null,
              document_number: row.documentNumber ?? null,
              person_type: row.personType,
              age: row.age ?? null,
              gender: row.gender,
              remark: row.remark ?? null,
            })),
          },
        },
      );
      const row = result[0];
      return { inserted: row?.inserted_count ?? 0, deleted: row?.deleted_count ?? 0 };
    },
  };
}

export function touristRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): TouristRepository {
  return environment.TOURIST_REPOSITORY ?? createSupabaseTouristRepository(environment, token);
}
