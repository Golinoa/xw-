import { expect, test } from '@playwright/test';
import {
  customerSourceDeletedResponseSchema,
  notificationUnreadResponseSchema,
  customerSourceListResponseSchema,
  customerSourceResponseSchema,
  tourRouteDeletedResponseSchema,
  tourRouteListResponseSchema,
  tourRouteResponseSchema,
  type CustomerSource,
  type TourRoute,
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
 * 线路主数据与客户来源两页：此前只有端点没有界面，主数据只能「加」不能「维护」。
 *
 * 这两个页面都是纯前端新增，最典型的坏法就是白屏或者按钮点不动——
 * 类型检查抓不到，只有真浏览器打开才知道。
 */

const AT = '2026-11-19T03:00:00.000Z';

interface MasterState {
  routes: TourRoute[];
  sources: CustomerSource[];
}

function route(overrides: Partial<TourRoute> = {}): TourRoute {
  return {
    id: 'route-1',
    name: '云南六日游',
    routeType: '境内跟团',
    region: '云南',
    departureCity: '上海',
    days: 6,
    isSelfGroup: true,
    isActive: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function source(overrides: Partial<CustomerSource> = {}): CustomerSource {
  return {
    id: 'source-1',
    parentId: null,
    name: '门店到访',
    sortOrder: 1,
    isActive: true,
    ...overrides,
  };
}

function handlers(state: MasterState): StubExtraHandler[] {
  return [
    async ({ route: r, stub, path, method, body }) => {
      // 布局在每页都会拉未读数；不接住就会记一条 unhandled，掩盖真正的漏实现。
      if (path === '/api/notifications/unread-count' && method === 'GET') {
        await reply(
          r,
          stub,
          'GET /api/notifications/unread-count',
          notificationUnreadResponseSchema,
          {
            count: 0,
          },
        );
        return true;
      }

      if (path === '/api/routes' && method === 'GET') {
        await reply(r, stub, 'GET /api/routes', tourRouteListResponseSchema, {
          items: state.routes,
          total: state.routes.length,
          page: 1,
          pageSize: 50,
        });
        return true;
      }
      const routeMatch = /^\/api\/routes\/([^/]+)$/.exec(path);
      if (routeMatch && method === 'PATCH') {
        const target = state.routes.find((item) => item.id === decodeURIComponent(routeMatch[1]!));
        if (!target) {
          await replyError(r, 'NOT_FOUND', 'stub: 线路不存在', 404);
          return true;
        }
        const patch = body as Partial<TourRoute>;
        Object.assign(target, patch, { updatedAt: AT });
        await reply(r, stub, 'PATCH /api/routes/:id', tourRouteResponseSchema, { route: target });
        return true;
      }
      if (routeMatch && method === 'DELETE') {
        const id = decodeURIComponent(routeMatch[1]!);
        state.routes = state.routes.filter((item) => item.id !== id);
        await reply(r, stub, 'DELETE /api/routes/:id', tourRouteDeletedResponseSchema, {
          deletedRouteId: id,
        });
        return true;
      }
      if (path === '/api/routes' && method === 'POST') {
        const created = route({ id: `route-${state.routes.length + 1}`, name: '新线路' });
        state.routes = [created, ...state.routes];
        await reply(r, stub, 'POST /api/routes', tourRouteResponseSchema, { route: created });
        return true;
      }

      if (path === '/api/customer-sources' && method === 'GET') {
        await reply(r, stub, 'GET /api/customer-sources', customerSourceListResponseSchema, {
          sources: state.sources,
        });
        return true;
      }
      const sourceMatch = /^\/api\/customer-sources\/([^/]+)$/.exec(path);
      if (sourceMatch && method === 'PATCH') {
        const target = state.sources.find(
          (item) => item.id === decodeURIComponent(sourceMatch[1]!),
        );
        if (!target) {
          await replyError(r, 'NOT_FOUND', 'stub: 来源不存在', 404);
          return true;
        }
        Object.assign(target, body as Partial<CustomerSource>);
        await reply(r, stub, 'PATCH /api/customer-sources/:id', customerSourceResponseSchema, {
          source: target,
        });
        return true;
      }
      if (sourceMatch && method === 'DELETE') {
        const id = decodeURIComponent(sourceMatch[1]!);
        state.sources = state.sources.filter((item) => item.id !== id);
        await reply(
          r,
          stub,
          'DELETE /api/customer-sources/:id',
          customerSourceDeletedResponseSchema,
          {
            deletedSourceId: id,
          },
        );
        return true;
      }
      if (path === '/api/customer-sources' && method === 'POST') {
        const created = source({ id: `source-${state.sources.length + 1}`, name: '新来源' });
        state.sources = [...state.sources, created];
        await reply(r, stub, 'POST /api/customer-sources', customerSourceResponseSchema, {
          source: created,
        });
        return true;
      }
      return false;
    },
  ];
}

function master() {
  const state: MasterState = { routes: [route()], sources: [source()] };
  return { state, extra: handlers(state) };
}

test('线路页：列表显示天数与自组标记，停用后状态跟着变', async ({ page }) => {
  const { state, extra } = master();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '线路', exact: true }).click();

  await expect(page.getByText('线路主数据')).toBeVisible();
  const row = page.locator('tbody tr.ant-table-row').first();
  await expect(row).toContainText('云南六日游');
  await expect(row).toContainText('自组');
  await expect(row).toContainText('启用');

  await row.getByRole('button', { name: buttonName('停用') }).click();
  await expect(page.getByText('线路已停用')).toBeVisible();
  await expect(row).toContainText('停用');
  expect(state.routes[0]!.isActive).toBe(false);
  expect(stub.violations).toEqual([]);
  expect(stub.unhandled).toEqual([]);
});

test('线路页：删除会问一次，确认后从列表消失', async ({ page }) => {
  const { state, extra } = master();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '线路', exact: true }).click();

  const row = page.locator('tbody tr.ant-table-row').first();
  await row.getByRole('button', { name: buttonName('删除') }).click();
  await page
    .locator('.ant-popconfirm')
    .getByRole('button', { name: buttonName('删除') })
    .click();

  await expect(page.getByText('线路已删除')).toBeVisible();
  await expect(page.getByText('共 0 条')).toBeVisible();
  expect(state.routes).toHaveLength(0);
  expect(stub.violations).toEqual([]);
});

test('客户来源页：能停用，停用后状态列变灰', async ({ page }) => {
  const { state, extra } = master();
  const stub = await installApiStub(page, { user: adminUser(), handlers: extra });
  await signIn(page, adminUser());
  await page.getByRole('link', { name: '客户来源', exact: true }).click();

  await expect(page.getByText('客户来源')).toBeVisible();
  const row = page.locator('tbody tr.ant-table-row').first();
  await expect(row).toContainText('门店到访');
  await expect(row).toContainText('启用');

  await row.getByRole('button', { name: buttonName('停用') }).click();
  await expect(page.getByText('来源已停用')).toBeVisible();
  await expect(row).toContainText('停用');
  expect(state.sources[0]!.isActive).toBe(false);
  expect(stub.violations).toEqual([]);
  expect(stub.unhandled).toEqual([]);
});
