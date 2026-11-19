import { expect, test } from '@playwright/test';
import {
  z,
  accountBalanceListResponseSchema,
  auditFacetsResponseSchema,
  auditListResponseSchema,
  companySettingsSchema,
  leadListResponseSchema,
  markNotificationsReadResponseSchema,
  notificationListResponseSchema,
  notificationUnreadResponseSchema,
  reportResponseSchema,
  supplierReportResponseSchema,
} from '@erp/contracts';
import {
  adminUser,
  installApiStub,
  reply,
  replyError,
  type StubExtraHandler,
} from './support/api-stub';
import { buttonName, signIn } from './support/session';

/**
 * C6–C12 新增的六个界面：余额、报表、审计、通知、公司配置、CRM。
 *
 * 这批页面此前只有类型检查与生产构建保过，**没有一条交互用例**：
 * 按钮点了会不会发请求、请求有没有带版本号，全靠人眼看代码。
 * 本文件补这一段——真浏览器、真点击；接口用桩拦住（服务端行为由 pgTAP
 * 与 HTTP 集成负责），桩的每个响应都先过 `@erp/contracts`。
 */

const AT = '2026-11-19T02:00:00.000Z';
const ORG_ID = 'f0000000-0000-4000-8000-000000000001';

/** 仅本文件用到的窄状态；不往共享 StubState 里加字段，避免打扰既有用例。 */
interface SurfaceState {
  settingsVersion: number;
  unread: number;
  readIds: string[];
  claimed: boolean;
}

type Ctx = Parameters<StubExtraHandler>[0];

function on(
  match: (path: string, method: string) => boolean,
  handle: (ctx: Ctx) => Promise<void>,
): StubExtraHandler {
  return async (ctx) => {
    if (!match(ctx.path, ctx.method)) return false;
    await handle(ctx);
    return true;
  };
}

function reportRange(url: URL) {
  return {
    from: url.searchParams.get('from') ?? '2026-11-01',
    to: url.searchParams.get('to') ?? '2026-11-30',
    includeCancelled: url.searchParams.get('includeCancelled') === 'true',
  };
}

function handlers(state: SurfaceState): StubExtraHandler[] {
  const lead = (ownerId: string | null, ownerName: string | null) => ({
    id: 'lead-1',
    name: '李先生',
    phone: '13900000101',
    wechat: null,
    email: null,
    source: '门店到访',
    destination: '云南',
    departureCity: '上海',
    tripType: '跟团游',
    intentLevel: '中',
    expectedDate: '2026-12-20',
    budgetMin: 3000,
    budgetMax: 6000,
    adultCount: 2,
    childCount: 0,
    remark: null,
    stage: 'new' as const,
    ownerId,
    ownerName,
    nextFollowUpAt: null,
    lastFollowUpAt: null,
    convertedCustomerId: null,
    version: 1,
    createdAt: AT,
  });

  return [
    on(
      (path, method) => path === '/api/account-balances' && method === 'GET',
      async ({ route, stub }) =>
        reply(route, stub, 'GET /api/account-balances', accountBalanceListResponseSchema, {
          items: [
            {
              accountId: 'account-1',
              accountName: '对公账户',
              method: 'bank',
              openingBalance: 1000,
              confirmedIn: 4000,
              confirmedOut: 1500,
              adjustments: -500,
              balance: 3000,
            },
          ],
        }),
    ),

    on(
      (path, method) => path === '/api/reports/tenant' && method === 'GET',
      async ({ route, stub, url }) =>
        reply(route, stub, 'GET /api/reports/tenant', reportResponseSchema, {
          dateField: 'createdAt',
          ...reportRange(url),
          overview: { orderCount: 3, receivableTotal: 20000, payableTotal: 12000, profit: 8000 },
          finance: { confirmedIn: 8000, pendingIn: 2000, confirmedOut: 5000, pendingOut: 1000 },
          byStatus: { active: 3 },
        }),
    ),

    on(
      (path, method) => path === '/api/reports/suppliers' && method === 'GET',
      async ({ route, stub }) =>
        reply(route, stub, 'GET /api/reports/suppliers', supplierReportResponseSchema, {
          items: [
            {
              supplierId: 'supplier-1',
              supplierName: '云岭地接',
              orderCount: 2,
              payableAmount: 12000,
              confirmedAmount: 6000,
            },
          ],
        }),
    ),

    on(
      (path, method) => path === '/api/audit-events/facets' && method === 'GET',
      async ({ route, stub }) =>
        reply(route, stub, 'GET /api/audit-events/facets', auditFacetsResponseSchema, {
          actions: ['order.status_changed', 'company_settings.updated'],
          entityTypes: ['order', 'company_settings'],
        }),
    ),

    on(
      (path, method) => path === '/api/audit-events' && method === 'GET',
      async ({ route, stub }) =>
        reply(route, stub, 'GET /api/audit-events', auditListResponseSchema, {
          items: [
            {
              id: 'audit-1',
              actorName: '张管理',
              action: 'order.status_changed',
              entityType: 'order',
              entityId: 'order-1',
              summary: '订单 ORD-2026-0011：预订 → 进行中',
              ipSummary: '203.0.113.0/24',
              deviceSummary: 'Chrome/120',
              requestId: 'req-1',
              createdAt: AT,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
    ),

    on(
      (path, method) => path === '/api/notifications/unread-count' && method === 'GET',
      async ({ route, stub }) =>
        reply(
          route,
          stub,
          'GET /api/notifications/unread-count',
          notificationUnreadResponseSchema,
          { count: state.unread },
        ),
    ),

    on(
      (path, method) => path === '/api/notifications' && method === 'GET',
      async ({ route, stub }) =>
        reply(route, stub, 'GET /api/notifications', notificationListResponseSchema, {
          items: [
            {
              id: 'notification-1',
              type: 'application_approved',
              title: '收款申请已通过',
              body: '你提交的收款申请 3,000.00 已终审通过',
              entityType: 'finance_application',
              entityId: 'application-1',
              read: false,
              createdAt: AT,
            },
            {
              id: 'notification-2',
              type: 'settlement_confirmed',
              title: '结算批次已确认',
              body: '结算批次 2026-11 已确认',
              entityType: 'settlement_batch',
              entityId: 'batch-1',
              read: true,
              createdAt: AT,
            },
          ],
          total: 2,
          page: 1,
          pageSize: 20,
        }),
    ),

    on(
      (path, method) => path === '/api/notifications/read' && method === 'PATCH',
      async ({ route, stub, body }) => {
        const ids = (body as { ids?: string[] } | undefined)?.ids ?? [];
        state.readIds = ids;
        state.unread = 0;
        await reply(
          route,
          stub,
          'PATCH /api/notifications/read',
          markNotificationsReadResponseSchema,
          {
            updated: ids.length,
          },
        );
      },
    ),

    on(
      (path, method) => path === '/api/company-settings' && method === 'GET',
      async ({ route, stub }) =>
        reply(route, stub, 'GET /api/company-settings', companySettingsSchema, {
          organizationId: ORG_ID,
          data: { companyName: '晨光旅行社', theme: 'light', fontSize: 'medium' },
          version: state.settingsVersion,
          updatedAt: AT,
          updatedBy: null,
        }),
    ),

    on(
      (path, method) => path === '/api/company-settings' && method === 'PATCH',
      async ({ route, stub, body }) => {
        const payload = body as { data?: Record<string, unknown>; expectedVersion?: number };
        if (payload.expectedVersion !== state.settingsVersion) {
          // 与真实服务端一致：409 + STATE_CONFLICT（details.reason = VERSION_MISMATCH）。
          // 前端按稳定 code 映射文案，所以这里断言的是映射后的那句「请刷新后再试」。
          await replyError(
            route,
            'STATE_CONFLICT',
            'Company settings were changed by someone else; reload before saving',
            409,
          );
          return;
        }
        state.settingsVersion += 1;
        await reply(route, stub, 'PATCH /api/company-settings', companySettingsSchema, {
          organizationId: ORG_ID,
          data: payload.data ?? {},
          version: state.settingsVersion,
          updatedAt: AT,
          updatedBy: null,
        });
      },
    ),

    on(
      (path, method) => path === '/api/leads' && method === 'GET',
      async ({ route, stub, url }) => {
        // 公海就是「无人认领」；认领之后回到「我的线索」。
        const inPool = url.searchParams.get('inPool') === 'true';
        const owned = !inPool && state.claimed;
        await reply(route, stub, 'GET /api/leads', leadListResponseSchema, {
          items: [lead(owned ? 'user-fixture' : null, owned ? '张管理' : null)],
          total: 1,
          page: 1,
          pageSize: 20,
        });
      },
    ),

    on(
      (path, method) => path === '/api/leads/claim' && method === 'POST',
      async ({ route, stub, body }) => {
        const payload = body as { leadId?: string; version?: number } | undefined;
        if (state.claimed || payload?.version !== 1) {
          await replyError(route, 'CONFLICT', '线索已被他人认领，请刷新', 409);
          return;
        }
        state.claimed = true;
        await reply(route, stub, 'POST /api/leads/claim', z.object({ success: z.boolean() }), {
          success: true,
        });
      },
    ),
  ];
}

function surface() {
  const state: SurfaceState = { settingsVersion: 2, unread: 2, readIds: [], claimed: false };
  return { state, extra: handlers(state) };
}

test('余额页展示口径与实时余额', async ({ page }) => {
  const { extra } = surface();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '余额', exact: true }).click();

  await expect(page.getByText('账户余额')).toBeVisible();
  await expect(page.getByText('共 1 个账户')).toBeVisible();
  const row = page.locator('tbody tr.ant-table-row').first();
  await expect(row).toContainText('对公账户');
  // 1,000 + 4,000 − 1,500 − 500 = 3,000；数字对不上就是口径写错了
  await expect(row).toContainText(/3[,.]?000/);
  expect(stub.violations).toEqual([]);
  expect(stub.unhandled).toEqual([]);
});

test('经营分析按创建日期出数，导出的 CSV 与页面同源', async ({ page }) => {
  const { extra } = surface();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '报表', exact: true }).click();

  await expect(page.getByText('经营分析')).toBeVisible();
  await expect(page.locator('.metric-value').first()).toHaveText('3');
  await expect(page.locator('tbody tr.ant-table-row').first()).toContainText('云岭地接');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: buttonName('导出 CSV') }).click();
  expect((await download).suggestedFilename()).toMatch(/经营报表_.*\.csv$/);

  expect(stub.requestsTo('GET', '/api/reports/tenant').length).toBeGreaterThan(0);
  expect(stub.violations).toEqual([]);
  expect(stub.unhandled).toEqual([]);
});

test('审计页只读：能看，且没有任何修改入口', async ({ page }) => {
  const { extra } = surface();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '日志', exact: true }).click();

  await expect(page.getByText('操作日志')).toBeVisible();
  await expect(page.getByText('共 1 条')).toBeVisible();
  const row = page.locator('tbody tr.ant-table-row').first();
  await expect(row).toContainText('张管理');
  await expect(row).toContainText('order.status_changed');

  // 筛选项来自服务端去重结果，不是前端写死的字典
  expect(stub.requestsTo('GET', '/api/audit-events/facets')).toHaveLength(1);
  await expect(page.getByRole('button', { name: /删\s*除|编\s*辑/ })).toHaveCount(0);
  expect(stub.violations).toEqual([]);
  expect(stub.unhandled).toEqual([]);
});

test('通知页：标记已读只提交选中的 id', async ({ page }) => {
  const { state, extra } = surface();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '通知' }).click();

  await expect(page.getByText('共 2 条')).toBeVisible();

  const unreadRow = page.locator('tbody tr.ant-table-row').first();
  await unreadRow.getByRole('button', { name: buttonName('标为已读') }).click();
  await expect(page.getByText('已标记为已读')).toBeVisible();

  const readCall = stub.requestsTo('PATCH', '/api/notifications/read');
  expect(readCall).toHaveLength(1);
  expect(readCall[0]!.body).toEqual({ ids: ['notification-1'] });
  expect(state.readIds).toEqual(['notification-1']);
  expect(stub.violations).toEqual([]);
  expect(stub.unhandled).toEqual([]);
});

test('公司配置保存带当前版本号，版本过期时明确告知刷新', async ({ page }) => {
  const { state, extra } = surface();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '设置', exact: true }).click();

  await expect(page.getByText('公司配置')).toBeVisible();
  await expect(page.getByText('当前版本 2')).toBeVisible();

  // a-form-item 的 label 没有 for 指向输入框，getByLabel 取不到，按「标签所在表单项」定位。
  const companyName = page
    .locator('.ant-form-item')
    .filter({ hasText: '公司名称' })
    .locator('input')
    .first();
  await companyName.fill('晨光旅行社（新）');
  await page.getByRole('button', { name: buttonName('保存配置') }).click();
  await expect(page.getByText('公司配置已保存')).toBeVisible();
  await expect(page.getByText('当前版本 3')).toBeVisible();

  const patch = stub.requestsTo('PATCH', '/api/company-settings');
  expect(patch).toHaveLength(1);
  expect((patch[0]!.body as { expectedVersion: number }).expectedVersion).toBe(2);

  // 别处已经改过：拿旧版本再存必须被拒，提示要指向「刷新」
  state.settingsVersion = 9;
  await page.getByRole('button', { name: buttonName('保存配置') }).click();
  await expect(page.getByText('当前状态不允许该操作，请刷新后再试')).toBeVisible();
  expect(stub.violations).toEqual([]);
  expect(stub.unhandled).toEqual([]);
});

test('公海线索认领带上版本号，认领后归属当前用户', async ({ page }) => {
  const { state, extra } = surface();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '线索', exact: true }).click();

  await expect(page.getByText('CRM 线索与公海')).toBeVisible();
  await page.getByText('公海', { exact: true }).click();

  const row = page.locator('tbody tr.ant-table-row').first();
  await expect(row).toContainText('李先生');
  await row.getByRole('button', { name: buttonName('认领') }).click();
  await expect(page.getByText('已认领')).toBeVisible();

  const claim = stub.requestsTo('POST', '/api/leads/claim');
  expect(claim).toHaveLength(1);
  // 乐观锁：认领必须带页面看到的版本号，否则并发时会覆盖别人的改动
  expect((claim[0]!.body as { version: number }).version).toBe(1);
  expect(state.claimed).toBe(true);
  expect(stub.violations).toEqual([]);
  expect(stub.unhandled).toEqual([]);
});
