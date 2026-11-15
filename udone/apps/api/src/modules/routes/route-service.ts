import type { SortOrder, TourRoute } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { RestConflictError, createRestClient } from '../../lib/rest-client';

/**
 * 线路主数据仓储（R-ROUTE-01）。
 *
 * 与供应商的唯一结构差异：线路**没有被任何表外键引用**，因为订单保存的是
 * 名称快照而不是线路 id。所以删除不做引用检查——这是设计，不是遗漏：
 * 删掉一条线路，历史订单的 `route_name` 仍是当时那个名字。
 */

const COLUMNS =
  'id,name,route_type,region,departure_city,days,is_self_group,is_active,remark,created_at,updated_at';

const SORT_COLUMNS: Record<string, string> = {
  name: 'name',
  createdAt: 'created_at',
  days: 'days',
};

type TourRouteRow = {
  id: string;
  name: string;
  route_type: string | null;
  region: string | null;
  departure_city: string | null;
  days: number | null;
  is_self_group: boolean;
  is_active: boolean;
  remark: string | null;
  created_at: string;
  updated_at: string;
};

export interface TourRouteListFilter {
  organizationId: string;
  keyword?: string;
  activeOnly: boolean;
  page: number;
  pageSize: number;
  sort: string;
  order: SortOrder;
}

export interface TourRouteCreateInput {
  name: string;
  routeType?: string | null;
  region?: string | null;
  departureCity?: string | null;
  days?: number | null;
  isSelfGroup?: boolean;
  remark?: string | null;
}

export interface TourRouteUpdateInput {
  name?: string;
  routeType?: string | null;
  region?: string | null;
  departureCity?: string | null;
  days?: number | null;
  isSelfGroup?: boolean;
  isActive?: boolean;
  remark?: string | null;
}

export interface TourRouteRepository {
  list(filter: TourRouteListFilter): Promise<{ items: TourRoute[]; total: number }>;
  create(organizationId: string, input: TourRouteCreateInput): Promise<TourRoute>;
  update(
    organizationId: string,
    routeId: string,
    patch: TourRouteUpdateInput,
  ): Promise<TourRoute | null>;
  remove(organizationId: string, routeId: string): Promise<boolean>;
}

export class TourRouteNameConflictError extends Error {
  constructor() {
    super('A route with this name already exists');
    this.name = 'TourRouteNameConflictError';
  }
}

function optional(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

function toRecord(row: TourRouteRow): TourRoute {
  return {
    id: row.id,
    name: row.name,
    routeType: optional(row.route_type),
    region: optional(row.region),
    departureCity: optional(row.departure_city),
    days: row.days ?? undefined,
    isSelfGroup: row.is_self_group,
    isActive: row.is_active,
    remark: optional(row.remark),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSupabaseTourRouteRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): TourRouteRepository {
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
      if (filter.keyword) {
        // 与供应商列表同一套清洗：PostgREST 的 ilike 值里 `,`/`(` 会被当成语法的一部分。
        const cleaned = filter.keyword
          .replace(/[,()*%\\]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleaned) query.set('name', `ilike.*${cleaned}*`);
      }

      const page = await client.restPage<TourRouteRow>(`routes?${query.toString()}`, {
        organizationId: filter.organizationId,
      });
      return { items: page.rows.map(toRecord), total: page.total };
    },

    async create(organizationId, input) {
      try {
        const rows = await client.rest<TourRouteRow[]>('routes', {
          method: 'POST',
          organizationId,
          headers: { Prefer: 'return=representation' },
          body: {
            organization_id: organizationId,
            name: input.name,
            route_type: input.routeType ?? null,
            region: input.region ?? null,
            departure_city: input.departureCity ?? null,
            days: input.days ?? null,
            is_self_group: input.isSelfGroup ?? false,
            remark: input.remark ?? null,
          },
        });
        const row = rows[0];
        if (!row) throw new Error('Route creation returned no row');
        return toRecord(row);
      } catch (cause) {
        if (cause instanceof RestConflictError) throw new TourRouteNameConflictError();
        throw cause;
      }
    },

    async update(organizationId, routeId, patch) {
      const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.routeType !== undefined) body.route_type = patch.routeType;
      if (patch.region !== undefined) body.region = patch.region;
      if (patch.departureCity !== undefined) body.departure_city = patch.departureCity;
      if (patch.days !== undefined) body.days = patch.days;
      if (patch.isSelfGroup !== undefined) body.is_self_group = patch.isSelfGroup;
      if (patch.isActive !== undefined) body.is_active = patch.isActive;
      if (patch.remark !== undefined) body.remark = patch.remark;

      try {
        const rows = await client.rest<TourRouteRow[]>(
          `routes?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(routeId)}`,
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
        if (cause instanceof RestConflictError) throw new TourRouteNameConflictError();
        throw cause;
      }
    },

    async remove(organizationId, routeId) {
      const rows = await client.rest<Array<{ id: string }>>(
        `routes?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(routeId)}`,
        {
          method: 'DELETE',
          organizationId,
          headers: { Prefer: 'return=representation' },
        },
      );
      return rows.length > 0;
    },
  };
}

export function tourRouteRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): TourRouteRepository {
  return environment.ROUTE_REPOSITORY ?? createSupabaseTourRouteRepository(environment, token);
}
