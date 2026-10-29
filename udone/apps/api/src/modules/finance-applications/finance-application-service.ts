import type {
  FinanceApplicationAction,
  FinanceApplicationActionItem,
  FinanceApplicationItem,
  FinanceApplicationKind,
  FinanceApplicationStatus,
  PaymentMethod,
  SortOrder,
} from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';
import { RestRequestError } from '../../lib/rest-client';
import { ilikePattern, inList, sanitizeKeyword } from '../../lib/postgrest';

/**
 * 收付款申请与审批（R-FIN-02 / R-FIN-03 / R-APPROVAL-02）。
 *
 * 这一层刻意**不含任何金额运算**：额度校验、在途占用、确认入账全在数据库函数里，
 * 因为它们必须和 `CHECK (confirmed + pending <= amount)` 在同一个事务、同一把行锁下
 * 完成。如果在这里先算一遍，应用层与库层就有两套口径，而金额一旦出现两套口径，
 * 早晚会有一笔钱在两边都不一样。
 *
 * 写入只有一个入口：RPC。客户端对本表没有任何写权限（迁移里没授予 authenticated），
 * 所以「直接 PATCH 把待审改成已确认」这条路在库层就已经堵死。
 */

const APPLICATION_COLUMNS = [
  'id',
  'kind',
  'status',
  'current_step',
  'order_id',
  'receivable_id',
  'payable_id',
  'amount',
  'method',
  'occurred_on',
  'reference_no',
  'voucher_url',
  'remark',
  'created_by',
  'created_at',
  'updated_at',
  'version',
].join(',');

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  amount: 'amount',
  occurredOn: 'occurred_on',
};

type ApplicationRow = {
  id: string;
  kind: FinanceApplicationKind;
  status: FinanceApplicationStatus;
  current_step: number;
  order_id: string;
  receivable_id: string | null;
  payable_id: string | null;
  amount: number;
  method: PaymentMethod;
  occurred_on: string;
  reference_no: string | null;
  voucher_url: string | null;
  remark: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};

type ActionRow = {
  id: string;
  step: number;
  action: FinanceApplicationAction;
  opinion: string | null;
  from_status: FinanceApplicationStatus;
  to_status: FinanceApplicationStatus;
  actor_id: string | null;
  created_at: string;
};

type OrderBriefRow = { id: string; order_number: string; customer_id: string };

export interface FinanceApplicationListFilter {
  organizationId: string;
  kind?: FinanceApplicationKind;
  status?: FinanceApplicationStatus;
  orderId?: string;
  keyword?: string;
  page: number;
  pageSize: number;
  sort: string;
  order: SortOrder;
}

export interface FinanceApplicationPage {
  items: FinanceApplicationItem[];
  total: number;
}

export interface FinanceApplicationDetail {
  application: FinanceApplicationItem;
  actions: FinanceApplicationActionItem[];
}

export interface CreateFinanceApplicationInput {
  kind: FinanceApplicationKind;
  orderId: string;
  lineId: string;
  amount: number;
  method: PaymentMethod;
  occurredOn: string;
  referenceNo?: string;
  voucherUrl?: string;
  remark?: string;
}

/**
 * 写入失败的原因。白名单而不是把库里的字符串原样透出：函数新增错误码时，
 * 这里必须显式加一行，否则会被当成「记录不存在」返回 404，把真正的原因藏起来。
 */
export type FinanceApplicationMutationError =
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'APPLICATION_STATE_CONFLICT'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'REASON_REQUIRED'
  | 'AMOUNT_EXCEEDS_AVAILABLE'
  | 'LINE_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_STATE_CONFLICT'
  | 'AMOUNT_INVALID'
  | 'KIND_INVALID'
  | 'ACTION_INVALID'
  | 'FORBIDDEN';

export type FinanceApplicationMutationResult =
  | { ok: true; application: FinanceApplicationItem }
  | { ok: false; errorCode: FinanceApplicationMutationError };

export interface FinanceApplicationRepository {
  list(filter: FinanceApplicationListFilter): Promise<FinanceApplicationPage>;
  findDetail(
    organizationId: string,
    applicationId: string,
  ): Promise<FinanceApplicationDetail | null>;
  create(
    organizationId: string,
    input: CreateFinanceApplicationInput,
  ): Promise<FinanceApplicationMutationResult>;
  decide(
    organizationId: string,
    applicationId: string,
    action: 'approve' | 'reject',
    opinion: string | undefined,
    version: number,
  ): Promise<FinanceApplicationMutationResult>;
  withdraw(
    organizationId: string,
    applicationId: string,
    reason: string,
    version: number,
  ): Promise<FinanceApplicationMutationResult>;
  undo(
    organizationId: string,
    applicationId: string,
    reason: string,
    version: number,
  ): Promise<FinanceApplicationMutationResult>;
}

const KNOWN_ERRORS: readonly FinanceApplicationMutationError[] = [
  'VERSION_CONFLICT',
  'APPLICATION_STATE_CONFLICT',
  'SELF_APPROVAL_FORBIDDEN',
  'REASON_REQUIRED',
  'AMOUNT_EXCEEDS_AVAILABLE',
  'LINE_NOT_FOUND',
  'ORDER_NOT_FOUND',
  'ORDER_STATE_CONFLICT',
  'AMOUNT_INVALID',
  'KIND_INVALID',
  'ACTION_INVALID',
  'FORBIDDEN',
];

function mutationFailure(errorCode: string | null): FinanceApplicationMutationResult {
  const matched = KNOWN_ERRORS.find((code) => code === errorCode);
  return { ok: false, errorCode: matched ?? 'NOT_FOUND' };
}

/**
 * 库函数用 `RAISE ... ERRCODE 42501` 表达「权限不够」（例如财务角色去点终审）。
 * PostgREST 把它翻成 403，rest-client 抛 RestRequestError。不接住就会变成 500，
 * 前端会显示「服务暂时不可用」——那是在说谎，用户只是没有这个权限。
 */
export class FinanceApplicationForbiddenError extends Error {
  constructor() {
    super('The database rejected this action for the current user');
    this.name = 'FinanceApplicationForbiddenError';
  }
}

function rethrowPermission(cause: unknown): never {
  if (cause instanceof RestRequestError && cause.status === 403) {
    throw new FinanceApplicationForbiddenError();
  }
  throw cause;
}

export function createSupabaseFinanceApplicationRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): FinanceApplicationRepository {
  const client = createRestClient(environment, token);

  function decorate(
    organizationId: string,
    rows: readonly ApplicationRow[],
  ): Promise<{
    orders: Map<string, OrderBriefRow>;
    customers: Map<string, string>;
    lines: Map<string, string>;
  }> {
    const orderIds = [...new Set(rows.map((row) => row.order_id))].filter(Boolean);
    const receivableIds = rows
      .map((row) => row.receivable_id)
      .filter((id): id is string => typeof id === 'string');
    const payableIds = rows
      .map((row) => row.payable_id)
      .filter((id): id is string => typeof id === 'string');

    return (async () => {
      const orders = new Map<string, OrderBriefRow>();
      const customers = new Map<string, string>();
      const lines = new Map<string, string>();

      if (orderIds.length > 0) {
        const orderRows = await client.rest<OrderBriefRow[]>(
          `orders?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(orderIds)}&select=id,order_number,customer_id`,
          { organizationId },
        );
        for (const row of orderRows) orders.set(row.id, row);

        const customerIds = [...new Set(orderRows.map((row) => row.customer_id))].filter(Boolean);
        if (customerIds.length > 0) {
          const customerRows = await client.rest<Array<{ id: string; name: string }>>(
            `customers?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(customerIds)}&select=id,name`,
            { organizationId },
          );
          for (const row of customerRows) customers.set(row.id, row.name);
        }
      }

      // 两类明细分开查：申请表用两个可空外键区分收付，没有一张统一的「明细」表。
      const lineQueries: Promise<void>[] = [];
      if (receivableIds.length > 0) {
        lineQueries.push(
          client
            .rest<Array<{ id: string; name: string }>>(
              `order_receivables?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(receivableIds)}&select=id,name`,
              { organizationId },
            )
            .then((lineRows) => {
              for (const row of lineRows) lines.set(row.id, row.name);
            }),
        );
      }
      if (payableIds.length > 0) {
        lineQueries.push(
          client
            .rest<Array<{ id: string; name: string }>>(
              `order_payables?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(payableIds)}&select=id,name`,
              { organizationId },
            )
            .then((lineRows) => {
              for (const row of lineRows) lines.set(row.id, row.name);
            }),
        );
      }
      await Promise.all(lineQueries);

      return { orders, customers, lines };
    })();
  }

  function toItem(
    row: ApplicationRow,
    decoration: {
      orders: Map<string, OrderBriefRow>;
      customers: Map<string, string>;
      lines: Map<string, string>;
    },
  ): FinanceApplicationItem {
    const order = decoration.orders.get(row.order_id);
    const lineId = row.receivable_id ?? row.payable_id ?? '';
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      currentStep: row.current_step,
      orderId: row.order_id,
      // 父订单读不到只可能是权限边界（RLS 顺着订单判定可见性），给占位符而不是编造。
      orderNumber: order?.order_number ?? '—',
      customerName: order ? (decoration.customers.get(order.customer_id) ?? '（客户已删除）') : '—',
      lineId,
      lineName: decoration.lines.get(lineId) ?? '（明细已删除）',
      amount: row.amount,
      method: row.method,
      occurredOn: row.occurred_on,
      referenceNo: row.reference_no,
      voucherUrl: row.voucher_url,
      remark: row.remark,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  async function findDetail(
    organizationId: string,
    applicationId: string,
  ): Promise<FinanceApplicationDetail | null> {
    const rows = await client.rest<ApplicationRow[]>(
      `finance_applications?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(applicationId)}&select=${APPLICATION_COLUMNS}&limit=1`,
      { organizationId },
    );
    const row = rows[0];
    if (!row) return null;
    const [decoration, actions] = await Promise.all([
      decorate(organizationId, [row]),
      client.rest<ActionRow[]>(
        `finance_application_actions?organization_id=eq.${encodeURIComponent(organizationId)}&application_id=eq.${encodeURIComponent(applicationId)}&select=id,step,action,opinion,from_status,to_status,actor_id,created_at&order=created_at.asc`,
        { organizationId },
      ),
    ]);
    return { application: toItem(row, decoration), actions: actions.map(toActionItem) };
  }

  /**
   * 关键词匹配订单号、客户名与明细行名称。
   *
   * 这三项都不在申请表上，只能各自先查一层：订单号在 orders、客户名在 customers、
   * 明细名在两张明细表。四次批量查询而不是让 PostgREST 做嵌套嵌入——本仓用的是
   * `(列, organization_id)` 复合外键，嵌入关系推断不稳，显式 `in.(...)` 结果可预期。
   */
  async function applyKeyword(
    query: URLSearchParams,
    organizationId: string,
    keyword: string,
  ): Promise<void> {
    const cleaned = sanitizeKeyword(keyword);
    if (!cleaned) return;
    const pattern = ilikePattern(cleaned);

    const [ordersByNumber, customers, receivables, payables] = await Promise.all([
      client.rest<Array<{ id: string }>>(
        `orders?organization_id=eq.${encodeURIComponent(organizationId)}&deleted_at=is.null&order_number=ilike.${pattern}&select=id&limit=50`,
        { organizationId },
      ),
      client.rest<Array<{ id: string }>>(
        `customers?organization_id=eq.${encodeURIComponent(organizationId)}&deleted_at=is.null&name=ilike.${pattern}&select=id&limit=50`,
        { organizationId },
      ),
      client.rest<Array<{ id: string }>>(
        `order_receivables?organization_id=eq.${encodeURIComponent(organizationId)}&name=ilike.${pattern}&select=id&limit=50`,
        { organizationId },
      ),
      client.rest<Array<{ id: string }>>(
        `order_payables?organization_id=eq.${encodeURIComponent(organizationId)}&name=ilike.${pattern}&select=id&limit=50`,
        { organizationId },
      ),
    ]);

    const orderIds = new Set(ordersByNumber.map((row) => row.id));
    if (customers.length > 0) {
      const ordersByCustomer = await client.rest<Array<{ id: string }>>(
        `orders?organization_id=eq.${encodeURIComponent(organizationId)}&deleted_at=is.null&customer_id=${inList(customers.map((row) => row.id))}&select=id&limit=50`,
        { organizationId },
      );
      for (const row of ordersByCustomer) orderIds.add(row.id);
    }

    const conditions: string[] = [];
    if (orderIds.size > 0) conditions.push(`order_id=${inList([...orderIds])}`);
    if (receivables.length > 0) {
      conditions.push(`receivable_id=${inList(receivables.map((row) => row.id))}`);
    }
    if (payables.length > 0) {
      conditions.push(`payable_id=${inList(payables.map((row) => row.id))}`);
    }

    // 关键词什么都没命中时必须返回空集，而不是退化成「没有筛选条件」把全部数据放出来。
    if (conditions.length === 0) {
      query.set('id', 'eq.00000000-0000-0000-0000-000000000000');
      return;
    }
    query.set('or', `(${conditions.join(',')})`);
  }

  return {
    async list(filter) {
      const query = new URLSearchParams();
      query.set('organization_id', `eq.${filter.organizationId}`);
      query.set('select', APPLICATION_COLUMNS);
      query.set('order', `${SORT_COLUMNS[filter.sort] ?? 'created_at'}.${filter.order}`);
      query.set('limit', String(filter.pageSize));
      query.set('offset', String((filter.page - 1) * filter.pageSize));
      if (filter.kind) query.set('kind', `eq.${filter.kind}`);
      if (filter.status) query.set('status', `eq.${filter.status}`);
      if (filter.orderId) query.set('order_id', `eq.${filter.orderId}`);
      await applyKeyword(query, filter.organizationId, filter.keyword ?? '');

      const page = await client.restPage<ApplicationRow>(
        `finance_applications?${query.toString()}`,
        { organizationId: filter.organizationId },
      );
      const decoration = await decorate(filter.organizationId, page.rows);
      return { total: page.total, items: page.rows.map((row) => toItem(row, decoration)) };
    },

    findDetail,

    async create(organizationId, input) {
      const rows = await client
        .rest<Array<{ result_application_id: string | null; error_code: string | null }>>(
          'rpc/create_finance_application',
          {
            method: 'POST',
            organizationId,
            body: {
              requested_kind: input.kind,
              requested_order_id: input.orderId,
              requested_line_id: input.lineId,
              requested_amount: input.amount,
              requested_method: input.method,
              requested_occurred_on: input.occurredOn,
              requested_reference_no: input.referenceNo ?? null,
              requested_voucher_url: input.voucherUrl ?? null,
              requested_remark: input.remark ?? null,
            },
          },
        )
        .catch(rethrowPermission);

      const outcome = rows[0];
      if (!outcome?.result_application_id) return mutationFailure(outcome?.error_code ?? null);

      // 申请创建后立刻重读，而不是把入参拼成一条「成功的响应」：金额以库为准，
      // 前端看到的就是库里真正写下的那一笔。
      const detail = await findDetail(organizationId, outcome.result_application_id);
      if (!detail) return mutationFailure('NOT_FOUND');
      return { ok: true, application: detail.application };
    },

    async decide(organizationId, applicationId, action, opinion, version) {
      const rows = await client
        .rest<Array<{ new_status: string | null; error_code: string | null }>>(
          'rpc/decide_finance_application',
          {
            method: 'POST',
            organizationId,
            body: {
              requested_application_id: applicationId,
              requested_action: action,
              requested_opinion: opinion ?? null,
              requested_version: version,
            },
          },
        )
        .catch(rethrowPermission);

      const outcome = rows[0];
      if (outcome?.error_code) {
        const failure = mutationFailure(outcome.error_code);
        // 「权限不足」由函数直接抛异常，这里只会是业务错误码；保留分支以防未来改成返回值。
        return failure;
      }
      const detail = await findDetail(organizationId, applicationId);
      if (!detail) return mutationFailure('NOT_FOUND');
      return { ok: true, application: detail.application };
    },

    async withdraw(organizationId, applicationId, reason, version) {
      const rows = await client
        .rest<Array<{ new_status: string | null; error_code: string | null }>>(
          'rpc/withdraw_finance_application',
          {
            method: 'POST',
            organizationId,
            body: {
              requested_application_id: applicationId,
              requested_reason: reason,
              requested_version: version,
            },
          },
        )
        .catch(rethrowPermission);

      const outcome = rows[0];
      if (outcome?.error_code) return mutationFailure(outcome.error_code);
      const detail = await findDetail(organizationId, applicationId);
      if (!detail) return mutationFailure('NOT_FOUND');
      return { ok: true, application: detail.application };
    },

    async undo(organizationId, applicationId, reason, version) {
      const rows = await client
        .rest<Array<{ new_status: string | null; error_code: string | null }>>(
          'rpc/undo_finance_application',
          {
            method: 'POST',
            organizationId,
            body: {
              requested_application_id: applicationId,
              requested_reason: reason,
              requested_version: version,
            },
          },
        )
        .catch(rethrowPermission);

      const outcome = rows[0];
      if (outcome?.error_code) return mutationFailure(outcome.error_code);
      const detail = await findDetail(organizationId, applicationId);
      if (!detail) return mutationFailure('NOT_FOUND');
      return { ok: true, application: detail.application };
    },
  };
}

function toActionItem(row: ActionRow): FinanceApplicationActionItem {
  return {
    id: row.id,
    step: row.step,
    action: row.action,
    opinion: row.opinion,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

export function financeApplicationRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): FinanceApplicationRepository {
  return (
    environment.FINANCE_APPLICATION_REPOSITORY ??
    createSupabaseFinanceApplicationRepository(environment, token)
  );
}
