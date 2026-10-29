import type { OrderStatus, PayableItem, ReceivableItem, SortOrder } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';
import { ilikePattern, inList, sanitizeKeyword } from '../../lib/postgrest';

/**
 * 财务项目查询（R-FIN-01）。
 *
 * 这一层只做两件事：把明细行连同它所属订单、客户、供应商的展示信息拼完整，
 * 以及把筛选条件翻成 PostgREST 表达式。**不做任何金额运算**——
 * 汇总口径在 `@erp/contracts` 的纯函数里，接口和单元测试共用同一份实现。
 *
 * 数据范围不在这一层过滤：`order_receivables` / `order_payables` 的 RLS 策略
 * 会顺着父订单判定 own/all（见 `20261029000003_finance_scope.sql`）。
 * 明细表没有 created_by，在应用层重新拼一遍范围规则只会制造第二套口径。
 */

const LINE_COLUMNS =
  'id,order_id,name,amount,confirmed_amount,pending_amount,available_amount,created_at';

/** 排序白名单：只允许明细自己的列，与契约里的 `FINANCE_SORT_FIELDS` 一一对应。 */
const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  amount: 'amount',
  availableAmount: 'available_amount',
};

type LineRow = {
  id: string;
  order_id: string;
  name: string;
  amount: number;
  confirmed_amount: number;
  pending_amount: number;
  available_amount: number;
  created_at: string;
};

type PayableLineRow = LineRow & { supplier_id: string };

type OrderBriefRow = {
  id: string;
  order_number: string;
  status: OrderStatus;
  customer_id: string;
};

export interface FinanceListFilter {
  organizationId: string;
  orderId?: string;
  keyword?: string;
  outstanding?: 'true' | 'false';
  page: number;
  pageSize: number;
  sort: string;
  order: SortOrder;
}

export interface PayableListFilter extends FinanceListFilter {
  supplierId?: string;
}

export interface FinancePage<T> {
  items: T[];
  total: number;
}

export interface FinanceRepository {
  listReceivables(filter: FinanceListFilter): Promise<FinancePage<ReceivableItem>>;
  listPayables(filter: PayableListFilter): Promise<FinancePage<PayableItem>>;
}

interface Decoration {
  orders: Map<string, OrderBriefRow>;
  customerNames: Map<string, string>;
  suppliers: Map<string, { name: string; settlement: 'monthly' | 'per_trip' }>;
}

export function createSupabaseFinanceRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): FinanceRepository {
  const client = createRestClient(environment, token);

  /**
   * 把当前页的明细行需要的外部信息一次取齐。
   *
   * 三次批量查询而不是让 PostgREST 做嵌套嵌入：明细 → 订单 → 客户是三跳，
   * 嵌入写法要求外键关系被 PostgREST 正确推断，而本仓用的是 `(列, organization_id)`
   * 复合外键，推断不稳；显式 `in.(...)` 的结果可预期，也不会产生 N+1。
   */
  async function decorate(
    organizationId: string,
    orderIds: string[],
    supplierIds: string[],
  ): Promise<Decoration> {
    const orders = new Map<string, OrderBriefRow>();
    const customerNames = new Map<string, string>();
    const suppliers = new Map<string, { name: string; settlement: 'monthly' | 'per_trip' }>();

    const uniqueOrderIds = [...new Set(orderIds)].filter(Boolean);
    if (uniqueOrderIds.length > 0) {
      const orderRows = await client.rest<OrderBriefRow[]>(
        `orders?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(uniqueOrderIds)}&select=id,order_number,status,customer_id`,
        { organizationId },
      );
      for (const row of orderRows) orders.set(row.id, row);

      const customerIds = [...new Set(orderRows.map((row) => row.customer_id))].filter(Boolean);
      if (customerIds.length > 0) {
        const customerRows = await client.rest<Array<{ id: string; name: string }>>(
          `customers?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(customerIds)}&select=id,name`,
          { organizationId },
        );
        for (const row of customerRows) customerNames.set(row.id, row.name);
      }
    }

    const uniqueSupplierIds = [...new Set(supplierIds)].filter(Boolean);
    if (uniqueSupplierIds.length > 0) {
      const supplierRows = await client.rest<
        Array<{ id: string; name: string; settlement: 'monthly' | 'per_trip' }>
      >(
        `suppliers?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(uniqueSupplierIds)}&select=id,name,settlement`,
        { organizationId },
      );
      for (const row of supplierRows) {
        suppliers.set(row.id, { name: row.name, settlement: row.settlement });
      }
    }

    return { orders, customerNames, suppliers };
  }

  function applyCommonFilters(
    query: URLSearchParams,
    filter: FinanceListFilter,
    extraColumns = '',
  ): void {
    query.set('organization_id', `eq.${filter.organizationId}`);
    query.set('select', extraColumns ? `${LINE_COLUMNS},${extraColumns}` : LINE_COLUMNS);
    query.set('order', `${SORT_COLUMNS[filter.sort] ?? 'created_at'}.${filter.order}`);
    query.set('limit', String(filter.pageSize));
    query.set('offset', String((filter.page - 1) * filter.pageSize));
    if (filter.orderId) query.set('order_id', `eq.${filter.orderId}`);
    if (filter.outstanding === 'true') query.set('available_amount', 'gt.0');
    if (filter.outstanding === 'false') query.set('available_amount', 'eq.0');
  }

  /**
   * 关键词同时匹配项目名与订单号。订单号不在明细表上，先查出命中的订单，
   * 再用 `order_id=in.(...)` 拼进同一个 `or` 表达式——与订单列表按客户名搜索同一手法。
   */
  async function applyKeyword(
    query: URLSearchParams,
    organizationId: string,
    keyword: string,
  ): Promise<void> {
    const cleaned = sanitizeKeyword(keyword);
    if (!cleaned) return;
    const pattern = ilikePattern(cleaned);
    const matchedOrders = await client.rest<Array<{ id: string }>>(
      `orders?organization_id=eq.${encodeURIComponent(organizationId)}&deleted_at=is.null&order_number=ilike.${pattern}&select=id&limit=50`,
      { organizationId },
    );
    const conditions = [`name.ilike.${pattern}`];
    if (matchedOrders.length > 0) {
      conditions.push(`order_id=${inList(matchedOrders.map((row) => row.id))}`);
    }
    query.set('or', `(${conditions.join(',')})`);
  }

  return {
    async listReceivables(filter) {
      const query = new URLSearchParams();
      applyCommonFilters(query, filter);
      await applyKeyword(query, filter.organizationId, filter.keyword ?? '');

      const page = await client.restPage<LineRow>(`order_receivables?${query.toString()}`, {
        organizationId: filter.organizationId,
      });
      const decoration = await decorate(
        filter.organizationId,
        page.rows.map((row) => row.order_id),
        [],
      );

      return {
        total: page.total,
        items: page.rows.map((row) => toItem(row, decoration)),
      };
    },

    async listPayables(filter) {
      const query = new URLSearchParams();
      applyCommonFilters(query, filter, 'supplier_id');
      if (filter.supplierId) query.set('supplier_id', `eq.${filter.supplierId}`);
      await applyKeyword(query, filter.organizationId, filter.keyword ?? '');

      const page = await client.restPage<PayableLineRow>(`order_payables?${query.toString()}`, {
        organizationId: filter.organizationId,
      });
      const decoration = await decorate(
        filter.organizationId,
        page.rows.map((row) => row.order_id),
        page.rows.map((row) => row.supplier_id),
      );

      return {
        total: page.total,
        items: page.rows.map((row) => {
          const supplier = decoration.suppliers.get(row.supplier_id);
          return {
            ...toItem(row, decoration),
            supplierId: row.supplier_id,
            // 供应商被停用或删除后仍要能看历史明细，此时名称退化为占位符而不是丢掉整行。
            supplierName: supplier?.name ?? '（供应商已停用）',
            settlement: supplier?.settlement ?? 'per_trip',
          };
        }),
      };
    },
  };
}

function toItem(row: LineRow, decoration: Decoration): ReceivableItem {
  const order = decoration.orders.get(row.order_id);
  return {
    id: row.id,
    orderId: row.order_id,
    // 父订单读不到时只可能是权限边界（RLS 已按父订单判定可见性），
    // 这种情况给占位符而不是编一个状态值——编造的状态会被前端当真。
    orderNumber: order?.order_number ?? '—',
    orderStatus: order?.status ?? null,
    customerName: order
      ? (decoration.customerNames.get(order.customer_id) ?? '（客户已删除）')
      : '—',
    name: row.name,
    amount: row.amount,
    confirmedAmount: row.confirmed_amount,
    pendingAmount: row.pending_amount,
    availableAmount: row.available_amount,
    createdAt: row.created_at,
  };
}

export function financeRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): FinanceRepository {
  return environment.FINANCE_REPOSITORY ?? createSupabaseFinanceRepository(environment, token);
}
