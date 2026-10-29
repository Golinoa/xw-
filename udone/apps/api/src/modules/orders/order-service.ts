import type { OrderAction, OrderStatus, OrderType, SortOrder } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';
import { inList, sanitizeKeyword } from '../../lib/postgrest';

/**
 * 订单域服务与仓储（R-ORDER-01/02/03）。
 *
 * 三条实现纪律：
 * 1. 金额合计、利润、可申请余额全部由数据库生成列或函数计算，这一层只做类型映射，
 *    绝不在 JS 里再加一遍总——浮点求和与数据库 numeric 求和迟早对不上。
 * 2. 创建、更新、状态迁移都走 RPC：它们各自需要「多表写入 + 校验」在一个事务里成立。
 * 3. 悲观判定（不存在 / 版本冲突 / 状态冲突）由函数返回 `error_code`，
 *    这一层原样上抛，由路由映射成 404 / 409 / 409。
 */

const LIST_COLUMNS =
  'id,order_number,order_type,status,customer_id,route_name,departure_date,return_date,adult_count,child_count,person_count,receivable_total,payable_total,profit,created_at,updated_at';
const DETAIL_COLUMNS =
  'id,order_number,order_type,status,previous_status,customer_id,route_name,departure_date,return_date,adult_count,child_count,person_count,receivable_total,payable_total,profit,status_reason,remark,version,created_by,created_at,updated_at';

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  departureDate: 'departure_date',
  orderNumber: 'order_number',
};

type OrderRow = {
  id: string;
  order_number: string;
  order_type: OrderType;
  status: OrderStatus;
  previous_status: OrderStatus | null;
  customer_id: string;
  route_name: string | null;
  departure_date: string | null;
  return_date: string | null;
  adult_count: number;
  child_count: number;
  person_count: number;
  receivable_total: number;
  payable_total: number;
  profit: number;
  status_reason: string | null;
  remark: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type ReceivableRow = {
  id: string;
  name: string;
  amount: number;
  confirmed_amount: number;
  pending_amount: number;
  available_amount: number;
};

type PayableRow = ReceivableRow & { supplier_id: string };

export interface OrderReceivableRecord {
  id: string;
  name: string;
  amount: number;
  confirmedAmount: number;
  pendingAmount: number;
  availableAmount: number;
}

export interface OrderPayableRecord extends OrderReceivableRecord {
  supplierId: string;
  supplierName: string;
}

export interface OrderRecord {
  id: string;
  orderNumber: string;
  orderType: OrderType;
  status: OrderStatus;
  previousStatus?: OrderStatus;
  customerId: string;
  customerName: string;
  routeName?: string;
  departureDate?: string;
  returnDate?: string;
  adultCount: number;
  childCount: number;
  personCount: number;
  receivableTotal: number;
  payableTotal: number;
  profit: number;
  statusReason?: string;
  remark?: string;
  receivables: OrderReceivableRecord[];
  payables: OrderPayableRecord[];
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderListFilter {
  organizationId: string;
  keyword?: string;
  status?: OrderStatus;
  orderType?: OrderType;
  customerId?: string;
  departureFrom?: string;
  departureTo?: string;
  page: number;
  pageSize: number;
  sort: string;
  order: SortOrder;
  /** own 数据范围只能看到本人创建的订单。 */
  ownerUserId?: string;
}

export interface OrderLineInput {
  name: string;
  amount: number;
}

export interface PayableLineInput extends OrderLineInput {
  supplierId: string;
}

export interface OrderWriteInput {
  customerId: string;
  orderType: OrderType;
  routeName?: string | null;
  departureDate?: string | null;
  returnDate?: string | null;
  adultCount: number;
  childCount: number;
  receivables: OrderLineInput[];
  payables: PayableLineInput[];
  remark?: string | null;
}

/** 乐观结果：要么拿回订单，要么拿回一个稳定的失败原因。 */
export type OrderMutationResult =
  | { ok: true; order: OrderRecord }
  | { ok: false; errorCode: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'ORDER_STATE_CONFLICT' };

interface RpcOutcome {
  result_order_id: string | null;
  error_code: string | null;
}

export interface OrderRepository {
  list(filter: OrderListFilter): Promise<{ items: OrderRecord[]; total: number }>;
  findById(organizationId: string, orderId: string): Promise<OrderRecord | null>;
  create(organizationId: string, input: OrderWriteInput): Promise<OrderRecord>;
  update(
    organizationId: string,
    orderId: string,
    version: number,
    input: OrderWriteInput,
  ): Promise<OrderMutationResult>;
  transition(
    organizationId: string,
    orderId: string,
    version: number,
    action: OrderAction,
    reason?: string,
  ): Promise<OrderMutationResult>;
}

/** 客户不存在或不属于当前组织；函数侧用 23503 报出，这里映射成校验错误。 */
export class OrderCustomerInvalidError extends Error {
  constructor() {
    super('The customer does not belong to this organization');
    this.name = 'OrderCustomerInvalidError';
  }
}

function toReceivable(row: ReceivableRow): OrderReceivableRecord {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    confirmedAmount: row.confirmed_amount,
    pendingAmount: row.pending_amount,
    availableAmount: row.available_amount,
  };
}

function toOptional(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

export function createSupabaseOrderRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): OrderRepository {
  const client = createRestClient(environment, token);

  async function loadCustomerNames(
    organizationId: string,
    customerIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(customerIds)].filter(Boolean);
    if (unique.length === 0) return new Map();
    const rows = await client.rest<Array<{ id: string; name: string }>>(
      `customers?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(unique)}&select=id,name`,
      { organizationId },
    );
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async function loadLines(
    organizationId: string,
    orderIds: string[],
  ): Promise<{
    receivables: Map<string, OrderReceivableRecord[]>;
    payables: Map<string, OrderPayableRecord[]>;
  }> {
    const receivables = new Map<string, OrderReceivableRecord[]>();
    const payables = new Map<string, OrderPayableRecord[]>();
    if (orderIds.length === 0) return { receivables, payables };

    const [receivableRows, payableRows] = await Promise.all([
      client.rest<Array<ReceivableRow & { order_id: string }>>(
        `order_receivables?organization_id=eq.${encodeURIComponent(organizationId)}&order_id=${inList(orderIds)}&select=id,order_id,name,amount,confirmed_amount,pending_amount,available_amount&order=created_at.asc`,
        { organizationId },
      ),
      client.rest<Array<PayableRow & { order_id: string }>>(
        `order_payables?organization_id=eq.${encodeURIComponent(organizationId)}&order_id=${inList(orderIds)}&select=id,order_id,supplier_id,name,amount,confirmed_amount,pending_amount,available_amount&order=created_at.asc`,
        { organizationId },
      ),
    ]);

    const supplierIds = [...new Set(payableRows.map((row) => row.supplier_id))].filter(Boolean);
    const supplierNames =
      supplierIds.length > 0
        ? new Map(
            (
              await client.rest<Array<{ id: string; name: string }>>(
                `suppliers?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(supplierIds)}&select=id,name`,
                { organizationId },
              )
            ).map((row) => [row.id, row.name]),
          )
        : new Map<string, string>();

    for (const row of receivableRows) {
      const bucket = receivables.get(row.order_id) ?? [];
      bucket.push(toReceivable(row));
      receivables.set(row.order_id, bucket);
    }
    for (const row of payableRows) {
      const bucket = payables.get(row.order_id) ?? [];
      bucket.push({
        ...toReceivable(row),
        supplierId: row.supplier_id,
        supplierName: supplierNames.get(row.supplier_id) ?? '（供应商已删除）',
      });
      payables.set(row.order_id, bucket);
    }
    return { receivables, payables };
  }

  async function decorate(organizationId: string, rows: OrderRow[]): Promise<OrderRecord[]> {
    if (rows.length === 0) return [];
    const orderIds = rows.map((row) => row.id);
    const [customerNames, lines] = await Promise.all([
      loadCustomerNames(
        organizationId,
        rows.map((row) => row.customer_id),
      ),
      loadLines(organizationId, orderIds),
    ]);

    return rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      orderType: row.order_type,
      status: row.status,
      previousStatus: row.previous_status ?? undefined,
      customerId: row.customer_id,
      customerName: customerNames.get(row.customer_id) ?? '（客户已删除）',
      routeName: toOptional(row.route_name),
      departureDate: toOptional(row.departure_date),
      returnDate: toOptional(row.return_date),
      adultCount: row.adult_count,
      childCount: row.child_count,
      personCount: row.person_count,
      receivableTotal: row.receivable_total,
      payableTotal: row.payable_total,
      profit: row.profit,
      statusReason: toOptional(row.status_reason),
      remark: toOptional(row.remark),
      receivables: lines.receivables.get(row.id) ?? [],
      payables: lines.payables.get(row.id) ?? [],
      version: row.version,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async function findById(organizationId: string, orderId: string): Promise<OrderRecord | null> {
    const rows = await client.rest<OrderRow[]>(
      `orders?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(orderId)}&deleted_at=is.null&select=${DETAIL_COLUMNS}&limit=1`,
      { organizationId },
    );
    const row = rows[0];
    if (!row) return null;
    const [decorated] = await decorate(organizationId, [row]);
    return decorated ?? null;
  }

  function rpcBody(input: OrderWriteInput) {
    return {
      requested_customer_id: input.customerId,
      requested_order_type: input.orderType,
      requested_receivables: input.receivables.map((line) => ({
        name: line.name,
        amount: line.amount,
      })),
      requested_payables: input.payables.map((line) => ({
        name: line.name,
        amount: line.amount,
        supplierId: line.supplierId,
      })),
      requested_route_name: input.routeName ?? null,
      requested_departure_date: input.departureDate ?? null,
      requested_return_date: input.returnDate ?? null,
      requested_adult_count: input.adultCount,
      requested_child_count: input.childCount,
      requested_remark: input.remark ?? null,
    };
  }

  function mutationFailure(errorCode: string | null): OrderMutationResult {
    if (errorCode === 'VERSION_CONFLICT' || errorCode === 'ORDER_STATE_CONFLICT') {
      return { ok: false, errorCode };
    }
    return { ok: false, errorCode: 'NOT_FOUND' };
  }

  return {
    async list(filter) {
      const query = new URLSearchParams();
      query.set('organization_id', `eq.${filter.organizationId}`);
      query.set('deleted_at', 'is.null');
      query.set('select', LIST_COLUMNS);
      query.set('order', `${SORT_COLUMNS[filter.sort] ?? 'created_at'}.${filter.order}`);
      query.set('limit', String(filter.pageSize));
      query.set('offset', String((filter.page - 1) * filter.pageSize));
      if (filter.ownerUserId) query.set('created_by', `eq.${filter.ownerUserId}`);
      if (filter.status) query.set('status', `eq.${filter.status}`);
      if (filter.orderType) query.set('order_type', `eq.${filter.orderType}`);
      if (filter.customerId) query.set('customer_id', `eq.${filter.customerId}`);
      if (filter.departureFrom) query.set('departure_date', `gte.${filter.departureFrom}`);
      if (filter.departureTo) query.append('departure_date', `lte.${filter.departureTo}`);

      const keyword = filter.keyword ? sanitizeKeyword(filter.keyword) : '';
      if (keyword) {
        const pattern = `*${keyword}*`;
        // 列表里展示客户名，但客户名不在 orders 表上；不补这一段，用户按客户名搜索会得到空列表。
        // 客户查询受 customers 的 RLS 限制，没有 customer.read 的账号只是搜不到客户名，不影响订单本身。
        const matchedCustomers = await client.rest<Array<{ id: string }>>(
          `customers?organization_id=eq.${encodeURIComponent(filter.organizationId)}&deleted_at=is.null&name=ilike.${pattern}&select=id&limit=50`,
          { organizationId: filter.organizationId },
        );
        const conditions = [`order_number.ilike.${pattern}`, `route_name.ilike.${pattern}`];
        if (matchedCustomers.length > 0) {
          conditions.push(`customer_id=${inList(matchedCustomers.map((row) => row.id))}`);
        }
        query.set('or', `(${conditions.join(',')})`);
      }

      const page = await client.restPage<OrderRow>(`orders?${query.toString()}`, {
        organizationId: filter.organizationId,
      });
      // 列表要展示「未收 / 未付」（R-ORDER-03），这两个数只能从明细行算出来。
      // 明细按当前页订单批量取一次，不会退化成 N+1。
      return { items: await decorate(filter.organizationId, page.rows), total: page.total };
    },

    findById,

    async create(organizationId, input) {
      let newId: string | null;
      try {
        newId = await client.rest<string | null>('rpc/create_order_with_items', {
          method: 'POST',
          organizationId,
          body: rpcBody(input),
        });
      } catch (cause) {
        // 函数用 23503 报「客户或供应商不属于本组织」，PostgREST 会转成 409。
        const status = (cause as { status?: number }).status;
        if (status === 409 || status === 400) throw new OrderCustomerInvalidError();
        throw cause;
      }
      if (!newId) throw new Error('Order creation returned no identifier');
      const created = await findById(organizationId, newId);
      if (!created) throw new Error('Created order could not be read back');
      return created;
    },

    async update(organizationId, orderId, version, input) {
      const rows = await client.rest<RpcOutcome[]>('rpc/update_order_with_items', {
        method: 'POST',
        organizationId,
        body: {
          requested_order_id: orderId,
          requested_version: version,
          ...rpcBody(input),
        },
      });
      const outcome = rows[0];
      if (!outcome?.result_order_id) return mutationFailure(outcome?.error_code ?? null);
      const order = await findById(organizationId, orderId);
      if (!order) return mutationFailure('NOT_FOUND');
      return { ok: true, order };
    },

    async transition(organizationId, orderId, version, action, reason) {
      const rows = await client.rest<
        Array<{
          result_order_id: string | null;
          new_status: string | null;
          error_code: string | null;
        }>
      >('rpc/transition_order_status', {
        method: 'POST',
        organizationId,
        body: {
          requested_order_id: orderId,
          requested_action: action,
          requested_version: version,
          requested_reason: reason ?? null,
        },
      });
      const outcome = rows[0];
      if (!outcome?.result_order_id) return mutationFailure(outcome?.error_code ?? null);
      const order = await findById(organizationId, orderId);
      if (!order) return mutationFailure('NOT_FOUND');
      return { ok: true, order };
    },
  };
}

export function orderRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): OrderRepository {
  return environment.ORDER_REPOSITORY ?? createSupabaseOrderRepository(environment, token);
}
