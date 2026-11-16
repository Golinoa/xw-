import type { SortOrder, SupplierSettlement, SupplierType } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { RestConflictError, createRestClient } from '../../lib/rest-client';

/**
 * 供应商仓储（R-SUPPLIER-01）。
 *
 * 列表 / 新建 / 删除。**不做编辑与停用**：停用属于主数据任务的开关，
 * 而删除的引用校验直接交给外键（`order_payables.supplier_id` 是 RESTRICT），
 * 不在这里自己数引用 —— 自己数会和真实约束产生两套口径。
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
  /** `in_use` 表示被应付行引用，外键挡住了删除。 */
  delete(organizationId: string, supplierId: string): Promise<'deleted' | 'not_found' | 'in_use'>;
}

/**
 * 关键词清洗：PostgREST 的 `ilike` 模式里，逗号会切断 in-list、括号与 `*` 是操作符、
 * `%` 是通配符、反斜杠是转义符。把它们换成空格，既不会让语法坏掉，
 * 也不会把用户输入的 `%` 当成「匹配一切」——那样搜「%」会返回整张表。
 */
export function sanitizeSupplierKeyword(value: string): string {
  return value
    .replace(/[,()*%\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
        const cleaned = sanitizeSupplierKeyword(filter.keyword);
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

    async delete(organizationId, supplierId) {
      try {
        const rows = await client.rest<Array<{ id: string }>>(
          `suppliers?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(supplierId)}`,
          {
            method: 'DELETE',
            organizationId,
            headers: { Prefer: 'return=representation' },
          },
        );
        return rows.length > 0 ? 'deleted' : 'not_found';
      } catch (cause) {
        // 外键是 RESTRICT：被应付行引用会以 23503 冲突回来。
        if (cause instanceof RestConflictError) return 'in_use';
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
