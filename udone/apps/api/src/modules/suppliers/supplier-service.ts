import type { SortOrder, SupplierSettlement, SupplierType } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { RestConflictError, createRestClient } from '../../lib/rest-client';

/**
 * 供应商仓储（R-SUPPLIER-01）。
 *
 * 本切片只做列表与新建：订单应付行需要一个可引用的真实供应商实体，
 * 编辑、停用、删除时引用校验（`OBJECT_REFERENCED`）留到主数据任务，
 * 不在没有引用统计的情况下假装支持。
 */

const COLUMNS = 'id,name,type,contact_name,phone,settlement,is_active,remark,created_at,updated_at';

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  name: 'name',
};

type SupplierRow = {
  id: string;
  name: string;
  type: SupplierType;
  contact_name: string | null;
  phone: string | null;
  settlement: SupplierSettlement;
  is_active: boolean;
  remark: string | null;
  created_at: string;
  updated_at: string;
};

export interface SupplierRecord {
  id: string;
  name: string;
  type: SupplierType;
  contactName?: string;
  phone?: string;
  settlement: SupplierSettlement;
  isActive: boolean;
  remark?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierListFilter {
  organizationId: string;
  keyword?: string;
  settlement?: SupplierSettlement;
  activeOnly: boolean;
  page: number;
  pageSize: number;
  sort: string;
  order: SortOrder;
}

export interface SupplierCreateInput {
  name: string;
  type: SupplierType;
  contactName?: string | null;
  phone?: string | null;
  settlement: SupplierSettlement;
  remark?: string | null;
}

export interface SupplierRepository {
  list(filter: SupplierListFilter): Promise<{ items: SupplierRecord[]; total: number }>;
  create(organizationId: string, input: SupplierCreateInput): Promise<SupplierRecord>;
}

export class SupplierNameConflictError extends Error {
  constructor() {
    super('A supplier with this name already exists');
    this.name = 'SupplierNameConflictError';
  }
}

function optional(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

function toRecord(row: SupplierRow): SupplierRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    contactName: optional(row.contact_name),
    phone: optional(row.phone),
    settlement: row.settlement,
    isActive: row.is_active,
    remark: optional(row.remark),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSupabaseSupplierRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): SupplierRepository {
  const client = createRestClient(environment, token);

  return {
    async list(filter) {
      const query = new URLSearchParams();
      query.set('organization_id', `eq.${filter.organizationId}`);
      query.set('select', COLUMNS);
      query.set('order', `${SORT_COLUMNS[filter.sort] ?? 'name'}.${filter.order}`);
      query.set('limit', String(filter.pageSize));
      query.set('offset', String((filter.page - 1) * filter.pageSize));
      if (filter.activeOnly) query.set('is_active', 'eq.true');
      if (filter.settlement) query.set('settlement', `eq.${filter.settlement}`);
      if (filter.keyword) {
        const cleaned = filter.keyword
          .replace(/[,()*%\\]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleaned) query.set('name', `ilike.*${cleaned}*`);
      }

      const page = await client.restPage<SupplierRow>(`suppliers?${query.toString()}`, {
        organizationId: filter.organizationId,
      });
      return { items: page.rows.map(toRecord), total: page.total };
    },

    async create(organizationId, input) {
      try {
        const rows = await client.rest<SupplierRow[]>('suppliers', {
          method: 'POST',
          organizationId,
          headers: { Prefer: 'return=representation' },
          body: {
            organization_id: organizationId,
            name: input.name,
            type: input.type,
            contact_name: input.contactName ?? null,
            phone: input.phone ?? null,
            settlement: input.settlement,
            remark: input.remark ?? null,
          },
        });
        const row = rows[0];
        if (!row) throw new Error('Supplier creation returned no row');
        return toRecord(row);
      } catch (cause) {
        if (cause instanceof RestConflictError) throw new SupplierNameConflictError();
        throw cause;
      }
    },
  };
}

export function supplierRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): SupplierRepository {
  return environment.SUPPLIER_REPOSITORY ?? createSupabaseSupplierRepository(environment, token);
}
