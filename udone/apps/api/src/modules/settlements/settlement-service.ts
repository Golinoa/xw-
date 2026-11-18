import type {
  SettlementBatch,
  SettlementBatchDetail,
  SettlementCandidate,
  SettlementItem,
  SettlementStatus,
  SortOrder,
} from '@erp/contracts';
import { settlementPeriodMonthOf, settlementPeriodStart } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { RestRequestError, createRestClient } from '../../lib/rest-client';
import { inList } from '../../lib/postgrest';

/**
 * 批量结算仓储（R-SETTLE-01）。
 *
 * 这一层没有任何金额运算：累计封顶、供应商一致性、周期校验全在库函数里，
 * 因为它们必须和行锁在同一个事务里完成。平台侧若再算一遍，就有两套口径，
 * 而两套口径的金额末了一定会有一处不一样。
 *
 * 草稿以外的一切写入都只走 RPC：`settlement_items` 对 authenticated 没有写权限，
 * 「直接 PATCH 把草稿改成已确认」这条路在库层就断了。
 */

const BATCH_COLUMNS = [
  'id',
  'supplier_id',
  'period_start',
  'method',
  'status',
  'total_amount',
  'note',
  'cancel_reason',
  'confirmed_at',
  'created_at',
  'updated_at',
].join(',');

const ITEM_COLUMNS = [
  'id',
  'order_id',
  'order_number',
  'payable_id',
  'payable_name',
  'amount',
  'confirmed_at',
].join(',');

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  periodMonth: 'period_start',
  totalAmount: 'total_amount',
};

type BatchRow = {
  id: string;
  supplier_id: string;
  period_start: string;
  method: SettlementBatch['method'];
  status: SettlementStatus;
  total_amount: number;
  note: string | null;
  cancel_reason: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

type ItemRow = {
  id: string;
  order_id: string;
  order_number: string;
  payable_id: string;
  payable_name: string;
  amount: number;
  confirmed_at: string | null;
};

type SupplierNameRow = { id: string; name: string };

type PayableRow = {
  id: string;
  order_id: string;
  name: string;
  amount: number;
};

type OrderBriefRow = {
  id: string;
  order_number: string;
  status: SettlementCandidate['orderStatus'];
};

type SettledRow = { payable_id: string; amount: number };

export type SettlementMutationError =
  | 'NOT_FOUND'
  | 'SUPPLIER_NOT_FOUND'
  | 'PAYABLE_NOT_FOUND'
  | 'PERIOD_INVALID'
  | 'METHOD_INVALID'
  | 'ITEMS_REQUIRED'
  | 'ITEM_INVALID'
  | 'DUPLICATE_ITEM'
  | 'SUPPLIER_MISMATCH'
  | 'BATCH_EXISTS'
  | 'EMPTY_BATCH'
  | 'AMOUNT_EXCEEDS_AVAILABLE'
  | 'STATE_CONFLICT'
  | 'REASON_REQUIRED';

/** 库函数用 42501 表达「权限不够」；不接住就会变成 500，等于把 403 说成故障。 */
export class SettlementForbiddenError extends Error {
  constructor() {
    super('The database rejected this action for the current user');
    this.name = 'SettlementForbiddenError';
  }
}

function rethrowPermission(cause: unknown): never {
  if (cause instanceof RestRequestError && cause.status === 403) {
    throw new SettlementForbiddenError();
  }
  throw cause;
}

export interface SettlementListFilter {
  organizationId: string;
  supplierId?: string;
  status?: SettlementStatus;
  periodMonth?: string;
  page: number;
  pageSize: number;
  sort: string;
  order: SortOrder;
}

export interface CreateSettlementInput {
  supplierId: string;
  periodMonth: string;
  method: SettlementBatch['method'];
  note?: string | undefined;
  items: Array<{ payableId: string; amount: number }>;
}

export interface SettlementRepository {
  list(filter: SettlementListFilter): Promise<{ items: SettlementBatch[]; total: number }>;
  get(organizationId: string, batchId: string): Promise<SettlementBatchDetail | null>;
  create(
    organizationId: string,
    input: CreateSettlementInput,
  ): Promise<{ batchId: string } | { error: SettlementMutationError }>;
  confirm(
    organizationId: string,
    batchId: string,
  ): Promise<
    { status: SettlementStatus; totalAmount: number } | { error: SettlementMutationError }
  >;
  cancel(
    organizationId: string,
    batchId: string,
    reason: string | undefined,
  ): Promise<{ status: SettlementStatus } | { error: SettlementMutationError }>;
  candidates(organizationId: string, supplierId: string): Promise<SettlementCandidate[]>;
}

function toBatch(row: BatchRow, supplierName: string, itemCount: number): SettlementBatch {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName,
    periodMonth: settlementPeriodMonthOf(row.period_start),
    method: row.method,
    status: row.status,
    totalAmount: row.total_amount,
    itemCount,
    ...(row.note ? { note: row.note } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: ItemRow): SettlementItem {
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    payableId: row.payable_id,
    payableName: row.payable_name,
    amount: row.amount,
    confirmed: row.confirmed_at !== null,
  };
}

export function createSupabaseSettlementRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): SettlementRepository {
  const client = createRestClient(environment, token);

  async function supplierNames(organizationId: string, ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const rows = await client.rest<SupplierNameRow[]>(
      `suppliers?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(ids)}&select=id,name`,
      { organizationId },
    );
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async function itemCounts(organizationId: string, batchIds: string[]) {
    if (batchIds.length === 0) return new Map<string, number>();
    const rows = await client.rest<Array<{ batch_id: string }>>(
      `settlement_items?organization_id=eq.${encodeURIComponent(organizationId)}&batch_id=${inList(batchIds)}&select=batch_id`,
      { organizationId },
    );
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.batch_id, (counts.get(row.batch_id) ?? 0) + 1);
    return counts;
  }

  return {
    async list(filter) {
      const query = new URLSearchParams();
      query.set('organization_id', `eq.${filter.organizationId}`);
      query.set('select', BATCH_COLUMNS);
      query.set('order', `${SORT_COLUMNS[filter.sort] ?? 'created_at'}.${filter.order}`);
      query.set('limit', String(filter.pageSize));
      query.set('offset', String((filter.page - 1) * filter.pageSize));
      if (filter.supplierId) query.set('supplier_id', `eq.${filter.supplierId}`);
      if (filter.status) query.set('status', `eq.${filter.status}`);
      if (filter.periodMonth)
        query.set('period_start', `eq.${settlementPeriodStart(filter.periodMonth)}`);

      const page = await client.restPage<BatchRow>(`settlement_batches?${query.toString()}`, {
        organizationId: filter.organizationId,
      });
      const names = await supplierNames(filter.organizationId, [
        ...new Set(page.rows.map((row) => row.supplier_id)),
      ]);
      const counts = await itemCounts(
        filter.organizationId,
        page.rows.map((row) => row.id),
      );
      return {
        items: page.rows.map((row) =>
          toBatch(row, names.get(row.supplier_id) ?? '', counts.get(row.id) ?? 0),
        ),
        total: page.total,
      };
    },

    async get(organizationId, batchId) {
      const rows = await client.rest<BatchRow[]>(
        `settlement_batches?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(batchId)}&select=${BATCH_COLUMNS}`,
        { organizationId },
      );
      const row = rows[0];
      if (!row) return null;

      const items = await client.rest<ItemRow[]>(
        `settlement_items?organization_id=eq.${encodeURIComponent(organizationId)}&batch_id=eq.${encodeURIComponent(batchId)}&select=${ITEM_COLUMNS}&order=order_number.asc`,
        { organizationId },
      );
      const names = await supplierNames(organizationId, [row.supplier_id]);
      return {
        ...toBatch(row, names.get(row.supplier_id) ?? '', items.length),
        items: items.map(toItem),
      };
    },

    async create(organizationId, input) {
      const rows = await client
        .rest<Array<{ result_batch_id: string | null; error_code: string | null }>>(
          'rpc/create_settlement_batch',
          {
            method: 'POST',
            organizationId,
            body: {
              requested_supplier_id: input.supplierId,
              // 库只收自然月首日：月 -> 日 的换算只在这里做一次，页面不拼日期。
              requested_period_start: settlementPeriodStart(input.periodMonth),
              requested_method: input.method,
              requested_note: input.note ?? null,
              requested_items: input.items.map((item) => ({
                payableId: item.payableId,
                amount: item.amount,
              })),
            },
          },
        )
        .catch(rethrowPermission);
      const row = rows[0];
      if (row?.error_code) return { error: row.error_code as SettlementMutationError };
      if (!row?.result_batch_id) return { error: 'NOT_FOUND' };
      return { batchId: row.result_batch_id };
    },

    async confirm(organizationId, batchId) {
      const rows = await client
        .rest<
          Array<{
            new_status: string | null;
            total_amount: number | null;
            error_code: string | null;
          }>
        >('rpc/confirm_settlement_batch', {
          method: 'POST',
          organizationId,
          body: { requested_batch_id: batchId },
        })
        .catch(rethrowPermission);
      const row = rows[0];
      if (row?.error_code) return { error: row.error_code as SettlementMutationError };
      return {
        status: (row?.new_status ?? 'confirmed') as SettlementStatus,
        totalAmount: row?.total_amount ?? 0,
      };
    },

    async cancel(organizationId, batchId, reason) {
      const rows = await client
        .rest<Array<{ new_status: string | null; error_code: string | null }>>(
          'rpc/cancel_settlement_batch',
          {
            method: 'POST',
            organizationId,
            body: { requested_batch_id: batchId, requested_reason: reason ?? null },
          },
        )
        .catch(rethrowPermission);
      const row = rows[0];
      if (row?.error_code) return { error: row.error_code as SettlementMutationError };
      return { status: (row?.new_status ?? 'cancelled') as SettlementStatus };
    },

    async candidates(organizationId, supplierId) {
      const payables = await client.rest<PayableRow[]>(
        `order_payables?organization_id=eq.${encodeURIComponent(organizationId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&select=id,order_id,name,amount&order=created_at.desc&limit=500`,
        { organizationId },
      );
      if (payables.length === 0) return [];

      const payableIds = payables.map((row) => row.id);
      // 已确认批次锁掉的金额。作废批次的 confirmed_at 已清空，因此不会算进来。
      const settled = await client.rest<SettledRow[]>(
        `settlement_items?organization_id=eq.${encodeURIComponent(organizationId)}&payable_id=${inList(payableIds)}&confirmed_at=not.is.null&select=payable_id,amount`,
        { organizationId },
      );
      const settledByPayable = new Map<string, number>();
      for (const row of settled) {
        settledByPayable.set(
          row.payable_id,
          (settledByPayable.get(row.payable_id) ?? 0) + row.amount,
        );
      }

      const orders = await client.rest<OrderBriefRow[]>(
        `orders?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList([
          ...new Set(payables.map((row) => row.order_id)),
        ])}&select=id,order_number,status`,
        { organizationId },
      );
      const orderById = new Map(orders.map((row) => [row.id, row]));

      return payables
        .map((row) => {
          const settledAmount = settledByPayable.get(row.id) ?? 0;
          const order = orderById.get(row.order_id);
          return {
            payableId: row.id,
            orderId: row.order_id,
            orderNumber: order?.order_number ?? '',
            orderStatus: (order?.status ?? 'booking') as SettlementCandidate['orderStatus'],
            payableName: row.name,
            supplierId,
            payableAmount: row.amount,
            settledAmount,
            remainingAmount: Math.round((row.amount - settledAmount) * 100) / 100,
          };
        })
        .filter((row) => row.remainingAmount > 0);
    },
  };
}

export function settlementRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): SettlementRepository {
  return (
    environment.SETTLEMENT_REPOSITORY ?? createSupabaseSettlementRepository(environment, token)
  );
}
