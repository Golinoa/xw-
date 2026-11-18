import type {
  AuditEvent,
  AuditFacetsResponse,
  AuditListQuery,
  AuditListResponse,
} from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';

const AUDIT_COLUMNS =
  'id,actor_id,action,entity_type,entity_id,request_id,metadata,ip_summary,device_summary,created_at';

type AuditRow = {
  id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  ip_summary: string | null;
  device_summary: string | null;
  created_at: string;
};

export interface AuditRepository {
  list(filter: AuditListQuery, organizationId: string): Promise<AuditListResponse>;
  facets(organizationId: string): Promise<AuditFacetsResponse>;
}

/** 从 metadata 里挑出能安全展示的字段，绝不整份回传。 */
function summarize(row: AuditRow): string {
  const metadata = row.metadata ?? {};
  const orderNumber = metadata.orderNumber;
  if (typeof orderNumber === 'string' && orderNumber) return `订单 ${orderNumber}`;
  const from = metadata.from;
  const to = metadata.to;
  if (typeof from === 'string' && typeof to === 'string') return `${from} → ${to}`;
  const reason = metadata.reason;
  if (typeof reason === 'string' && reason) return reason;
  return row.action;
}

export function auditRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): AuditRepository {
  const client = createRestClient(environment, token);

  return {
    async list(filter, organizationId) {
      const query = new URLSearchParams();
      query.set('organization_id', `eq.${organizationId}`);
      query.set('select', AUDIT_COLUMNS);
      query.set('order', `${SORT_COLUMNS[filter.sort] ?? 'created_at'}.${filter.order}`);
      query.set('limit', String(filter.pageSize));
      query.set('offset', String((filter.page - 1) * filter.pageSize));
      if (filter.actorId) query.set('actor_id', `eq.${filter.actorId}`);
      if (filter.action) query.set('action', `eq.${filter.action}`);
      if (filter.entityType) query.set('entity_type', `eq.${filter.entityType}`);
      if (filter.from) query.set('created_at', `gte.${filter.from}`);
      if (filter.to) query.append('created_at', `lte.${filter.to}`);

      const page = await client.restPage<AuditRow>(`audit_events?${query.toString()}`, {
        organizationId,
      });
      const rows = page.rows;

      const actorIds = [...new Set(rows.map((row) => row.actor_id).filter(Boolean))] as string[];
      const actorNames = await loadActorNames(client, organizationId, actorIds);

      const items: AuditEvent[] = rows.map((row) => ({
        id: row.id,
        actorName: actorNames.get(row.actor_id ?? '') ?? '系统',
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        summary: summarize(row),
        ipSummary: row.ip_summary,
        deviceSummary: row.device_summary,
        requestId: row.request_id,
        createdAt: row.created_at,
      }));

      return {
        items,
        total: page.total,
        page: filter.page,
        pageSize: filter.pageSize,
      };
    },

    async facets(organizationId) {
      const rows = await client.rest<Array<{ action: string; entity_type: string | null }>>(
        `audit_events?organization_id=eq.${organizationId}&select=action,entity_type&limit=1000`,
        { organizationId },
      );
      return {
        actions: [...new Set(rows.map((row) => row.action))].sort(),
        entityTypes: [
          ...new Set(rows.map((row) => row.entity_type).filter(Boolean)),
        ].sort() as string[],
      };
    },
  };
}

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  action: 'action',
  entityType: 'entity_type',
};

async function loadActorNames(
  client: ReturnType<typeof createRestClient>,
  organizationId: string,
  actorIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!actorIds.length) return names;
  const profiles = await client
    .rest<Array<{ id: string; display_name: string | null }>>(
      `profiles?organization_id=eq.${organizationId}&id=${inList(actorIds)}&select=id,display_name`,
      { organizationId },
    )
    .catch(() => []);
  for (const profile of profiles) {
    names.set(profile.id, profile.display_name ?? profile.id.slice(0, 8));
  }
  return names;
}

function inList(values: string[]): string {
  return `in.(${values.join(',')})`;
}
