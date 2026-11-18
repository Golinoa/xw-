import type { Lead, LeadDetailResponse, LeadListQuery, LeadListResponse } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';

const LEAD_COLUMNS =
  'id,name,phone,wechat,email,source,destination,departure_city,trip_type,intent_level,expected_date,budget_min,budget_max,adult_count,child_count,remark,stage,owner_id,next_follow_up_at,last_follow_up_at,converted_customer_id,version,created_at';

type LeadRow = {
  id: string;
  name: string;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  source: string | null;
  destination: string | null;
  departure_city: string | null;
  trip_type: string | null;
  intent_level: string | null;
  expected_date: string | null;
  budget_min: number | null;
  budget_max: number | null;
  adult_count: number;
  child_count: number;
  remark: string | null;
  stage: Lead['stage'];
  owner_id: string | null;
  next_follow_up_at: string | null;
  last_follow_up_at: string | null;
  converted_customer_id: string | null;
  version: number;
  created_at: string;
};

type EventRow = {
  id: string;
  event_type: string;
  detail: string | null;
  actor_id: string | null;
  created_at: string;
};

type RpcResult = { error_code: string | null } & Record<string, unknown>;

function toLead(row: LeadRow, ownerNames: Map<string, string>): Lead {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    wechat: row.wechat,
    email: row.email,
    source: row.source,
    destination: row.destination,
    departureCity: row.departure_city,
    tripType: row.trip_type,
    intentLevel: row.intent_level,
    expectedDate: row.expected_date,
    budgetMin: row.budget_min,
    budgetMax: row.budget_max,
    adultCount: row.adult_count,
    childCount: row.child_count,
    remark: row.remark,
    stage: row.stage,
    ownerId: row.owner_id,
    ownerName: row.owner_id ? (ownerNames.get(row.owner_id) ?? null) : null,
    nextFollowUpAt: row.next_follow_up_at,
    lastFollowUpAt: row.last_follow_up_at,
    convertedCustomerId: row.converted_customer_id,
    version: row.version,
    createdAt: row.created_at,
  };
}

export interface LeadRepository {
  list(filter: LeadListQuery, organizationId: string): Promise<LeadListResponse>;
  get(leadId: string, organizationId: string): Promise<LeadDetailResponse | null>;
  create(
    input: Record<string, unknown>,
    organizationId: string,
  ): Promise<{ leadId?: string; error?: string }>;
  followUp(input: Record<string, unknown>, organizationId: string): Promise<string | null>;
  claim(input: { leadId: string; version: number }, organizationId: string): Promise<string | null>;
  assign(
    input: { leadId: string; version: number; ownerId: string },
    organizationId: string,
  ): Promise<string | null>;
  convert(leadId: string, organizationId: string): Promise<{ customerId?: string; error?: string }>;
}

export function leadRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): LeadRepository {
  const client = createRestClient(environment, token);

  async function ownerNames(rows: LeadRow[], organizationId: string): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => row.owner_id).filter(Boolean))] as string[];
    if (!ids.length) return new Map();
    const profiles = await client
      .rest<Array<{ id: string; display_name: string | null }>>(
        `profiles?organization_id=eq.${organizationId}&id=in.(${ids.join(',')})&select=id,display_name`,
        { organizationId },
      )
      .catch(() => []);
    return new Map(profiles.map((p) => [p.id, p.display_name ?? p.id.slice(0, 8)]));
  }

  return {
    async list(filter, organizationId) {
      const query = new URLSearchParams();
      query.set('organization_id', `eq.${organizationId}`);
      query.set('select', LEAD_COLUMNS);
      query.set('order', `${SORT[filter.sort] ?? 'created_at'}.${filter.order}`);
      query.set('limit', String(filter.pageSize));
      query.set('offset', String((filter.page - 1) * filter.pageSize));
      if (filter.stage) query.set('stage', `eq.${filter.stage}`);
      if (filter.ownerId) query.set('owner_id', `eq.${filter.ownerId}`);
      if (filter.inPool) query.set('owner_id', 'is.null');

      const page = await client.restPage<LeadRow>(`leads?${query.toString()}`, { organizationId });
      const names = await ownerNames(page.rows, organizationId);
      return {
        items: page.rows.map((row) => toLead(row, names)),
        total: page.total,
        page: filter.page,
        pageSize: filter.pageSize,
      };
    },

    async get(leadId, organizationId) {
      const rows = await client.rest<LeadRow[]>(
        `leads?organization_id=eq.${organizationId}&id=eq.${leadId}&select=${LEAD_COLUMNS}`,
        { organizationId },
      );
      const row = rows[0];
      if (!row) return null;
      const names = await ownerNames([row], organizationId);
      const events = await client.rest<EventRow[]>(
        `lead_events?organization_id=eq.${organizationId}&lead_id=eq.${leadId}&select=id,event_type,detail,actor_id,created_at&order=created_at.desc`,
        { organizationId },
      );
      const eventNames = await ownerNames(
        events.map((e) => ({ ...e, owner_id: e.actor_id }) as unknown as LeadRow),
        organizationId,
      );
      return {
        ...toLead(row, names),
        events: events.map((e) => ({
          id: e.id,
          eventType: e.event_type,
          detail: e.detail,
          actorName: e.actor_id ? (eventNames.get(e.actor_id) ?? '系统') : '系统',
          createdAt: e.created_at,
        })),
      };
    },

    async create(input, organizationId) {
      const rows = await client.rest<RpcResult[]>('rpc/create_lead', {
        method: 'POST',
        organizationId,
        body: {
          requested_name: input.name,
          requested_phone: input.phone,
          requested_wechat: input.wechat ?? null,
          requested_email: input.email ?? null,
          requested_source: input.source,
          requested_destination: input.destination,
          requested_departure_city: input.departureCity,
          requested_trip_type: input.tripType,
          requested_intent_level: input.intentLevel,
          requested_expected_date: input.expectedDate,
          requested_budget_min: input.budgetMin,
          requested_budget_max: input.budgetMax,
          requested_adult_count: input.adultCount,
          requested_child_count: input.childCount,
          requested_remark: input.remark ?? null,
        },
      });
      const row = rows[0];
      if (row?.error_code) return { error: row.error_code };
      const id = row?.result_lead_id;
      return typeof id === 'string' ? { leadId: id } : { error: 'VALIDATION_ERROR' };
    },

    async followUp(input, organizationId) {
      const rows = await client.rest<RpcResult[]>('rpc/record_lead_follow_up', {
        method: 'POST',
        organizationId,
        body: {
          requested_lead_id: input.leadId,
          requested_stage: input.stage,
          requested_detail: input.detail,
          requested_next_follow_up_at: input.nextFollowUpAt ?? null,
        },
      });
      return rows[0]?.error_code ?? null;
    },

    async claim(input, organizationId) {
      const rows = await client.rest<RpcResult[]>('rpc/claim_lead', {
        method: 'POST',
        organizationId,
        body: { requested_lead_id: input.leadId, requested_version: input.version },
      });
      return rows[0]?.error_code ?? null;
    },

    async assign(input, organizationId) {
      const rows = await client.rest<RpcResult[]>('rpc/assign_lead', {
        method: 'POST',
        organizationId,
        body: {
          requested_lead_id: input.leadId,
          requested_owner_id: input.ownerId,
          requested_version: input.version,
        },
      });
      return rows[0]?.error_code ?? null;
    },

    async convert(leadId, organizationId) {
      const rows = await client.rest<RpcResult[]>('rpc/convert_lead_to_customer', {
        method: 'POST',
        organizationId,
        body: { requested_lead_id: leadId },
      });
      const row = rows[0];
      if (row?.error_code) return { error: row.error_code };
      const id = row?.result_customer_id;
      return typeof id === 'string' ? { customerId: id } : { error: 'CONVERSION_FAILED' };
    },
  };
}

const SORT: Record<string, string> = {
  createdAt: 'created_at',
  stage: 'stage',
  nextFollowUpAt: 'next_follow_up_at',
};
