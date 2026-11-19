import type { Page, Route } from '@playwright/test';
import {
  DEFAULT_PAGE_SIZE,
  FINANCE_APPLICATION_FINAL_STEP,
  apiErrorBodySchema,
  createFinanceApplicationRequestSchema,
  customerListResponseSchema,
  decideFinanceApplicationRequestSchema,
  financeApplicationListResponseSchema,
  financeApplicationResponseSchema,
  meResponseSchema,
  orderFinanceResponseSchema,
  orderListResponseSchema,
  orderResponseSchema,
  summarizeAmountLines,
  summarizeOrderFinance,
  touristRosterResponseSchema,
  type AuthRole,
  type FinanceApplicationItem,
  type OrderDetail,
} from '@erp/contracts';

/**
 * 前端主线 E2E 的接口桩。
 *
 * 三条硬约束，目的是让这套用例「证明前端」，而不是「养活一份平行契约」：
 *
 * 1. **出站响应先过契约再返回**。每个响应体都用 `@erp/contracts` 的 schema 解析，
 *    不一致就记一条 violation 并回 500 —— 桩与契约漂移时用例当场红，
 *    而不是长久地绿着、把错误字段喂给界面。
 * 2. **入站请求也过契约**。POST/PATCH 的请求体同样解析；否则「前端漏传必填字段」
 *    这种最该被抓到的缺陷会被桩照单全收。
 * 3. **金额由契约里的纯函数算**。`summarizeAmountLines` / `summarizeOrderFinance`
 *    是服务端也在用的同一份口径，桩里不再手写第二套算术。
 *
 * 桩只模拟前端看到的 HTTP 契约，**不模拟 RLS、事务与并发锁**。所以这套用例的边界是
 * 「渲染与交互正确」，不是「服务端行为正确」——那部分由 pgTAP 与 HTTP 集成测试负责。
 */

export interface StubUser {
  id: string;
  email: string;
  role: AuthRole;
  organizationId: string;
  organizationName: string;
}

export interface StubState {
  order: OrderDetail;
  applications: FinanceApplicationItem[];
  /** 让订单列表持续失败：用于「加载失败」与「重试成功」两条路径。 */
  failOrderList: boolean;
  /** 返回空列表：空态与失败态必须长得不一样。 */
  emptyOrderList: boolean;
  customers: { id: string; name: string; createdAt: string; updatedAt: string }[];
  /** 游客名单：为空表示「这单还没录人」。导出用例需要非空数据才能验。 */
  rosterItems: unknown[];
}

export interface CapturedRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
  userId: string;
}

export interface ApiStub {
  state: StubState;
  user: StubUser;
  requests: CapturedRequest[];
  /** 桩与契约不一致的记录：每个用例结束时必须为空。 */
  violations: string[];
  /** 未被桩覆盖的 /api 请求，仅用于排查。 */
  unhandled: string[];
  requestsTo(method: string, pathPrefix: string): CapturedRequest[];
}

/** 新模块端点的扩展处理函数；见 `installApiStub` 的 `handlers` 选项。 */
export type StubExtraHandler = (context: {
  route: Route;
  stub: ApiStub;
  path: string;
  method: string;
  url: URL;
  body: unknown;
}) => Promise<boolean>;

/** 只依赖 safeParse 的结构，不把 zod 的类型体系引进用例。 */
interface SchemaLike<T> {
  safeParse(input: unknown): ParseResultLike<T>;
}

type ParseResultLike<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
    };

const STUB_ORG_HEADER = 'x-organization-id';

function describeIssues(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}) {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** 出站：先解析再返回。解析失败记 violation 并回 500，让界面进错误态而不是拿到假数据。 */
export async function reply<T>(
  route: Route,
  stub: ApiStub,
  label: string,
  schema: SchemaLike<T>,
  payload: unknown,
  status = 200,
): Promise<void> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    stub.violations.push(`${label} 响应 → ${describeIssues(parsed.error)}`);
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify(errorBody('INTERNAL_ERROR', 'stub 响应不符合契约')),
    });
    return;
  }
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(parsed.data),
  });
}

/** 入站：请求体必须符合契约，否则同样是契约漂移。返回 null 表示已回 400。 */
export function parseRequest<T>(
  stub: ApiStub,
  label: string,
  schema: SchemaLike<T>,
  payload: unknown,
): T | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    stub.violations.push(`${label} 请求 → ${describeIssues(parsed.error)}`);
    return null;
  }
  return parsed.data;
}

function errorBody(code: string, message: string) {
  return apiErrorBodySchema.parse({ code, message, requestId: 'stub-request' });
}

export async function replyError(route: Route, code: string, message: string, status: number) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(errorBody(code, message)),
  });
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 行上的可申请余额由契约函数算，和详情/列表的汇总口径同源。 */
function withAvailability(order: OrderDetail): OrderDetail {
  return {
    ...order,
    receivables: order.receivables.map((line) => ({
      ...line,
      availableAmount: summarizeAmountLines([line]).applicable,
    })),
    payables: order.payables.map((line) => ({
      ...line,
      availableAmount: summarizeAmountLines([line]).applicable,
    })),
  };
}

/** 订单合计随明细变化重算：详情页展示的合计不能比列表页旧。 */
function withTotals(order: OrderDetail): OrderDetail {
  const receivable = summarizeAmountLines(order.receivables);
  const payable = summarizeAmountLines(order.payables);
  return {
    ...order,
    receivableTotal: receivable.total,
    payableTotal: payable.total,
    profit: roundMoney(receivable.total - payable.total),
    uncollectedAmount: receivable.outstanding,
    unpaidAmount: payable.outstanding,
  };
}

export function normalizeOrder(order: OrderDetail): OrderDetail {
  return withAvailability(withTotals(order));
}

export function financeFor(order: OrderDetail) {
  return summarizeOrderFinance({
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    personCount: order.personCount,
    receivables: order.receivables,
    payables: order.payables,
  });
}

const SEEDED_AT = '2026-11-10T02:00:00.000Z';

/**
 * 默认订单：应收 12,000 已确认 4,000、应付 6,000 全部未付。
 * 数字选得能一眼分辨三种钱：已收 4,000、未收 8,000、在途 0。
 */
export function createStubState(overrides: Partial<StubState> = {}): StubState {
  const order: OrderDetail = {
    id: 'order-1',
    orderNumber: 'ORD-2026-0011',
    customerId: 'customer-1',
    customerName: '晨光旅行社',
    orderType: 'active',
    status: 'active',
    routeName: '云南六日',
    departureDate: '2026-11-20',
    returnDate: '2026-11-25',
    adultCount: 2,
    childCount: 0,
    personCount: 2,
    receivableTotal: 0,
    payableTotal: 0,
    profit: 0,
    uncollectedAmount: 0,
    unpaidAmount: 0,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    remark: '含双飞往返',
    receivables: [
      {
        id: 'receivable-1',
        name: '团款',
        amount: 12000,
        confirmedAmount: 4000,
        pendingAmount: 0,
        availableAmount: 8000,
      },
    ],
    payables: [
      {
        id: 'payable-1',
        supplierId: 'supplier-1',
        supplierName: '云岭地接',
        name: '地接费',
        amount: 6000,
        confirmedAmount: 0,
        pendingAmount: 0,
        availableAmount: 6000,
      },
    ],
    version: 3,
  };
  return {
    order: normalizeOrder(order),
    applications: [],
    failOrderList: false,
    emptyOrderList: false,
    customers: [
      { id: 'customer-1', name: '晨光旅行社', createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
    ],
    rosterItems: [],
    ...overrides,
  };
}

/**
 * 预置一笔别人的待审申请。
 *
 * 「驳回必须填原因」这条守卫只有在能审批别人的单据时才可达（自己的单据按钮不出现），
 * 所以夹具必须由**另一个用户**提交，否则用例会走成一条真实系统里到不了的分支。
 */
export function seedPendingApplication(
  state: StubState,
  options: { amount: number; createdBy?: string; kind?: 'receipt' | 'payment' },
): FinanceApplicationItem {
  const kind = options.kind ?? 'receipt';
  const line = kind === 'receipt' ? state.order.receivables[0]! : state.order.payables[0]!;
  const application: FinanceApplicationItem = {
    id: `application-seed-${state.applications.length + 1}`,
    kind,
    status: 'pending',
    currentStep: 1,
    orderId: state.order.id,
    orderNumber: state.order.orderNumber,
    customerName: state.order.customerName,
    lineId: line.id,
    lineName: line.name,
    amount: options.amount,
    method: 'bank',
    occurredOn: '2026-11-12',
    referenceNo: null,
    voucherUrl: null,
    remark: null,
    createdBy: options.createdBy ?? 'user-operator',
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    version: 1,
  };
  line.pendingAmount = roundMoney(line.pendingAmount + options.amount);
  state.applications.push(application);
  state.order = normalizeOrder(state.order);
  return application;
}

export function adminUser(): StubUser {
  return {
    id: 'user-admin',
    email: 'admin@example.test',
    role: 'admin',
    organizationId: 'org-alpha',
    organizationName: 'Alpha Travel',
  };
}

/** 计调：能开单、能报款，不能审批。 */
export function operatorUser(): StubUser {
  return {
    id: 'user-operator',
    email: 'operator@example.test',
    role: 'operator',
    organizationId: 'org-alpha',
    organizationName: 'Alpha Travel',
  };
}

/** 财务：能看订单、能报款、能审批，但没有 order.write。 */
export function financeUser(): StubUser {
  return {
    id: 'user-finance',
    email: 'finance@example.test',
    role: 'finance',
    organizationId: 'org-alpha',
    organizationName: 'Alpha Travel',
  };
}

function sessionFor(user: StubUser) {
  return {
    access_token: `fixture-access-token-${user.id}`,
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: `fixture-refresh-${user.id}`,
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: '2026-11-01T00:00:00.000Z',
    },
  };
}

type LineState = {
  id: string;
  name: string;
  amount: number;
  confirmedAmount: number;
  pendingAmount: number;
};

function findLine(state: StubState, kind: 'receipt' | 'payment', lineId: string) {
  const lines: LineState[] = kind === 'receipt' ? state.order.receivables : state.order.payables;
  return lines.find((line) => line.id === lineId);
}

/**
 * 把桩挂到页面上。**必须在任何导航之前调用**：`page.route` 只对注册之后发出的
 * 请求生效，挂晚了登录那一次 `/api/me` 就会打到真实网络。
 */
export async function installApiStub(
  page: Page,
  options: {
    state?: StubState;
    user?: StubUser;
    /**
     * 扩展点：给后来新增的模块补端点，而不往既有分发里塞分支。
     * 返回 true 表示已处理（用例自己 `route.fulfill`）；返回 false 落回默认分发，
     * 仍走「未覆盖的接口」记录，漏实现不会被悄悄放过。
     */
    handlers?: StubExtraHandler[];
  } = {},
): Promise<ApiStub> {
  const stub: ApiStub = {
    state: options.state ?? createStubState(),
    user: options.user ?? adminUser(),
    requests: [],
    violations: [],
    unhandled: [],
    requestsTo(method, pathPrefix) {
      return stub.requests.filter(
        (item) => item.method === method && item.path.startsWith(pathPrefix),
      );
    },
  };
  const user = stub.user;

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    // 只有 API 与 Auth 走桩；vite 的模块请求必须放行，否则页面根本起不来。
    if (!path.startsWith('/api/') && !path.startsWith('/auth/v1/')) {
      await route.fallback();
      return;
    }

    let body: unknown;
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = request.postData();
      body = raw ? (JSON.parse(raw) as unknown) : undefined;
    }
    stub.requests.push({ method, path, search: url.search, body, userId: user.id });

    const organizationId = request.headers()[STUB_ORG_HEADER] ?? '';

    if (path === '/auth/v1/token') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sessionFor(user)),
      });
      return;
    }
    if (path.startsWith('/auth/v1/logout')) {
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === '/api/me') {
      await reply(route, stub, 'GET /api/me', meResponseSchema, {
        userId: user.id,
        memberships: [
          {
            organizationId: user.organizationId,
            organizationName: user.organizationName,
            role: user.role,
          },
        ],
      });
      return;
    }
    if (path === '/api/customers' && method === 'GET') {
      // 客户筛选下拉：用例不依赖它，但缺了会让列表页多一行「客户筛选加载失败」。
      await reply(route, stub, 'GET /api/customers', customerListResponseSchema, {
        items: stub.state.customers.map((customer) => ({ ...customer, tags: [] })),
        total: stub.state.customers.length,
        page: 1,
        pageSize: 100,
      });
      return;
    }
    if (path === '/api/orders' && method === 'GET') {
      if (stub.state.failOrderList) {
        await replyError(route, 'INTERNAL_ERROR', 'stub: 订单列表按要求失败', 500);
        return;
      }
      const items = stub.state.emptyOrderList ? [] : [stub.state.order];
      await reply(route, stub, 'GET /api/orders', orderListResponseSchema, {
        items,
        total: items.length,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      });
      return;
    }
    if (path === '/api/finance-applications' && method === 'GET') {
      const status = url.searchParams.get('status');
      const items = status
        ? stub.state.applications.filter((item) => item.status === status)
        : stub.state.applications;
      await reply(
        route,
        stub,
        'GET /api/finance-applications',
        financeApplicationListResponseSchema,
        { items, total: items.length, page: 1, pageSize: DEFAULT_PAGE_SIZE },
      );
      return;
    }
    if (path === '/api/finance-applications' && method === 'POST') {
      const payload = parseRequest(
        stub,
        'POST /api/finance-applications',
        createFinanceApplicationRequestSchema,
        body,
      );
      if (!payload) {
        await replyError(route, 'VALIDATION_ERROR', 'stub: 请求不符合契约', 400);
        return;
      }
      if (payload.orderId !== stub.state.order.id) {
        await replyError(route, 'NOT_FOUND', 'stub: 订单不存在', 404);
        return;
      }
      const line = findLine(stub.state, payload.kind, payload.lineId);
      if (!line) {
        await replyError(route, 'NOT_FOUND', 'stub: 金额行不存在', 404);
        return;
      }
      // 超额判定用契约函数算的余额，和界面上的「可申请余额」是同一个数。
      if (payload.amount > summarizeAmountLines([line]).applicable) {
        await replyError(route, 'FINANCE_AMOUNT_EXCEEDS_AVAILABLE', 'stub: 超过可申请余额', 409);
        return;
      }
      const now = new Date().toISOString();
      const application: FinanceApplicationItem = {
        id: `application-${stub.state.applications.length + 1}`,
        kind: payload.kind,
        status: 'pending',
        currentStep: 1,
        orderId: stub.state.order.id,
        orderNumber: stub.state.order.orderNumber,
        customerName: stub.state.order.customerName,
        lineId: line.id,
        lineName: line.name,
        amount: payload.amount,
        method: payload.method,
        occurredOn: payload.occurredOn,
        referenceNo: payload.referenceNo ?? null,
        voucherUrl: payload.voucherUrl ?? null,
        remark: payload.remark ?? null,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      line.pendingAmount = roundMoney(line.pendingAmount + payload.amount);
      stub.state.applications.push(application);
      stub.state.order = normalizeOrder(stub.state.order);
      await reply(
        route,
        stub,
        'POST /api/finance-applications',
        financeApplicationResponseSchema,
        { application },
        201,
      );
      return;
    }

    const orderMatch = /^\/api\/orders\/([^/]+)(\/finance|\/tourists)?$/.exec(path);
    if (orderMatch && method === 'GET') {
      const orderId = decodeURIComponent(orderMatch[1]!);
      if (!organizationId) {
        await replyError(route, 'ORG_CONTEXT_REQUIRED', 'stub: 缺少公司上下文', 400);
        return;
      }
      if (orderId !== stub.state.order.id) {
        await replyError(route, 'NOT_FOUND', 'stub: 订单不存在', 404);
        return;
      }
      if (orderMatch[2] === '/finance') {
        await reply(route, stub, 'GET /api/orders/:id/finance', orderFinanceResponseSchema, {
          finance: financeFor(stub.state.order),
        });
        return;
      }
      if (orderMatch[2] === '/tourists') {
        // 名单不在本卡范围：给一份空名单，避免订单详情里出现一次假的加载失败。
        await reply(route, stub, 'GET /api/orders/:id/tourists', touristRosterResponseSchema, {
          roster: {
            items: stub.state.rosterItems,
            total: 0,
            adultCount: 0,
            childCount: 0,
            personCount: 0,
            declaredAdultCount: stub.state.order.adultCount,
            declaredChildCount: stub.state.order.childCount,
          },
        });
        return;
      }
      await reply(route, stub, 'GET /api/orders/:id', orderResponseSchema, {
        order: stub.state.order,
      });
      return;
    }

    const decideMatch = /^\/api\/finance-applications\/([^/]+)$/.exec(path);
    if (decideMatch && method === 'PATCH') {
      const payload = parseRequest(
        stub,
        'PATCH /api/finance-applications/:id',
        decideFinanceApplicationRequestSchema,
        body,
      );
      if (!payload) {
        await replyError(route, 'VALIDATION_ERROR', 'stub: 请求不符合契约', 400);
        return;
      }
      const application = stub.state.applications.find(
        (item) => item.id === decodeURIComponent(decideMatch[1]!),
      );
      if (!application) {
        await replyError(route, 'NOT_FOUND', 'stub: 申请不存在', 404);
        return;
      }
      // 同人审批在服务端被禁止。桩不复刻这条规则，用例就会在「真实系统做不到」的路径上变绿。
      if (application.createdBy === user.id) {
        await replyError(route, 'FINANCE_SELF_APPROVAL_FORBIDDEN', 'stub: 不能审批自己的申请', 403);
        return;
      }
      if (application.status !== 'pending' || application.version !== payload.version) {
        await replyError(route, 'CONFLICT', 'stub: 申请已被处理或版本过期', 409);
        return;
      }
      const line = findLine(stub.state, application.kind, application.lineId);
      if (!line) {
        await replyError(route, 'NOT_FOUND', 'stub: 金额行不存在', 404);
        return;
      }
      if (payload.action === 'reject') {
        application.status = 'rejected';
        line.pendingAmount = roundMoney(line.pendingAmount - application.amount);
      } else if (application.currentStep < FINANCE_APPLICATION_FINAL_STEP) {
        // 一级通过只推进级次：钱还在途，没入账。
        application.currentStep += 1;
      } else {
        application.status = 'approved';
        line.pendingAmount = roundMoney(line.pendingAmount - application.amount);
        line.confirmedAmount = roundMoney(line.confirmedAmount + application.amount);
      }
      application.updatedAt = new Date().toISOString();
      application.version += 1;
      stub.state.order = normalizeOrder(stub.state.order);
      await reply(
        route,
        stub,
        'PATCH /api/finance-applications/:id',
        financeApplicationResponseSchema,
        { application },
      );
      return;
    }

    for (const handler of options.handlers ?? []) {
      if (await handler({ route, stub, path, method, url, body })) return;
    }

    stub.unhandled.push(`${method} ${path}${url.search}`);
    await replyError(route, 'NOT_FOUND', 'stub: 未覆盖的接口', 404);
  });
  return stub;
}
