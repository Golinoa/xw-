import {
  customerSourceListResponseSchema,
  supplierListResponseSchema,
  supplierSchema,
  tourRouteListResponseSchema,
} from '@erp/contracts';
import { expect, test } from '@playwright/test';

import { fulfillJson, installAuthStub, signIn } from './support/session';

/**
 * 阶段 3.3 的主数据三页：供应商 / 线路 / 客户来源。
 *
 * 这一批的共同点是「共享字典」：它们被订单和客户表单引用，所以迁错的代价不在本页，
 * 而在别的页面上悄悄失效（下拉消失、历史单据改名）。因此用例的重心是**请求体**：
 * 新建省略空字段、编辑用 `null` 清空、引用被占用的供应商不能删。
 *
 * 选择器口径：antd 会给**两个汉字**的按钮自动插入空格（`保存` → `保 存`），
 * 所以这类按钮一律用正则匹配；四个字以上不会插空格。下拉选项必须从
 * `.ant-select-dropdown` 里点，`getByRole('option')` 命中的是 antd 隐藏的
 * a11y 镜像列表，名字是原始枚举值（`hotel`），点它没有反应。
 */

const supplier = supplierSchema.parse({
  contactName: '王经理',
  createdAt: '2026-11-20T02:00:00.000Z',
  id: 'supplier-1',
  isActive: true,
  name: '杭州假日酒店',
  phone: '0571-88880000',
  settlement: 'per_trip',
  type: 'hotel',
  updatedAt: '2026-11-20T02:00:00.000Z',
});

const supplierList = supplierListResponseSchema.parse({
  items: [supplier],
  page: 1,
  pageSize: 15,
  total: 1,
});

test('供应商列表渲染，新建时默认单团结算且省略空可选字段', async ({ page }) => {
  await installAuthStub(page);

  const createdBodies: Record<string, unknown>[] = [];

  await page.route('**/api/suppliers?**', (route) => fulfillJson(route, supplierList));
  await page.route('**/api/suppliers', async (route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      createdBodies.push(body);
      return fulfillJson(
        route,
        { supplier: { ...supplier, id: 'supplier-2', name: body.name as string } },
        201,
      );
    }
    return fulfillJson(route, supplierList);
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/trade/suppliers');

  await expect(page.getByText('杭州假日酒店')).toBeVisible();
  await expect(page.getByText('单团结算')).toBeVisible();

  await page.getByRole('button', { name: '新建供应商' }).click();
  await page.getByLabel('名称').fill('千岛湖鱼庄');
  // 类型是必填枚举：点开下拉再选，顺带证明选项文案来自语言包而不是硬编码。
  await page.getByLabel('类型').click();
  await page.locator('.ant-select-dropdown').getByText('餐厅', { exact: true }).click();
  await page.getByRole('button', { name: /保\s*存/ }).click();

  expect(createdBodies).toHaveLength(1);
  expect(createdBodies[0]).toStrictEqual({
    name: '千岛湖鱼庄',
    settlement: 'per_trip',
    type: 'restaurant',
  });
});

/**
 * 「不能删」与「删失败」必须是两种提示。
 *
 * 服务端对被应付行引用的供应商回 409 OBJECT_REFERENCED；如果前端把这一律当成
 * 普通错误弹「删除失败，请重试」，用户会反复点删除，永远得不到「去停用」这个正解。
 */
test('删除被引用供应商时提示改为停用，而不是通用失败', async ({ page }) => {
  await installAuthStub(page);

  await page.route('**/api/suppliers?**', (route) => fulfillJson(route, supplierList));
  await page.route('**/api/suppliers', (route) => fulfillJson(route, supplierList));
  await page.route('**/api/suppliers/supplier-1', (route) => {
    if (route.request().method() === 'DELETE') {
      return fulfillJson(
        route,
        {
          code: 'OBJECT_REFERENCED',
          message: 'Supplier is referenced by payable lines',
          requestId: 'req-fixture-supplier',
        },
        409,
      );
    }
    return fulfillJson(route, { supplier });
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/trade/suppliers');

  await page.getByRole('button', { name: /删\s*除/ }).click();
  await page.locator('.ant-popover').getByRole('button', { name: /删\s*除/ }).click();

  await expect(page.getByText('该供应商已被应付单据引用，不能删除；可以改为停用')).toBeVisible();
});

const routeFixture = {
  createdAt: '2026-11-20T02:00:00.000Z',
  days: 6,
  departureCity: '杭州',
  id: 'route-1',
  isActive: true,
  isSelfGroup: true,
  name: '云南六日游',
  region: '云南',
  routeType: '境内跟团',
  updatedAt: '2026-11-20T02:00:00.000Z',
};

test('新建线路：自组团进请求体，未填天数不出现在请求体里', async ({ page }) => {
  await installAuthStub(page);

  const createdBodies: Record<string, unknown>[] = [];

  // 一个 handler 同时管 GET 与 POST：列表请求带查询串，另外注册只匹配无查询串的
  // `**/api/routes` 会漏到真网络（踩过：列表空白，看起来像页面没渲染）。
  const routeList = tourRouteListResponseSchema.parse({
    items: [routeFixture],
    page: 1,
    pageSize: 15,
    total: 1,
  });
  await page.route('**/api/routes**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      createdBodies.push(body);
      return fulfillJson(route, { route: { ...routeFixture, name: body.name as string } }, 201);
    }
    return fulfillJson(route, routeList);
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/trade/routes');

  await expect(page.getByText('云南六日游')).toBeVisible();
  // 「自组」标记必须出现在类型列旁边：它影响报价口径，藏在备注里等于没有。
  await expect(page.getByText('自组')).toBeVisible();

  await page.getByRole('button', { name: '新建线路' }).click();
  await page.getByLabel('线路名称').fill('贵州五日游');
  await page.getByLabel('天数').fill('5');
  await page.getByLabel('自组团').check();
  await page.getByRole('button', { name: /保\s*存/ }).click();

  expect(createdBodies).toHaveLength(1);
  expect(createdBodies[0]).toStrictEqual({ days: 5, isSelfGroup: true, name: '贵州五日游' });
});

test('客户来源：编辑时上级不可改，新建可以挂到上级', async ({ page }) => {
  await installAuthStub(page);

  const sources = customerSourceListResponseSchema.parse({
    sources: [
      { id: 'source-root', isActive: true, name: '门店到访', parentId: null, sortOrder: 0 },
      { id: 'source-child', isActive: true, name: '老客转介绍', parentId: 'source-root', sortOrder: 1 },
      // 停用项也必须在列表里：服务端默认过滤掉它，页面不带 `includeInactive=1`
      // 就会「停用即失踪」，这一格是钉住那个参数的。
      { id: 'source-off', isActive: false, name: '展会地推', parentId: null, sortOrder: 2 },
    ],
  });

  const createdBodies: Record<string, unknown>[] = [];
  const listUrls: string[] = [];

  await page.route('**/api/customer-sources**', async (route) => {
    if (route.request().method() === 'GET') listUrls.push(route.request().url());
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      createdBodies.push(body);
      return fulfillJson(
        route,
        {
          source: {
            id: 'source-new',
            isActive: true,
            name: body.name as string,
            parentId: (body.parentId as string | undefined) ?? null,
            sortOrder: (body.sortOrder as number | undefined) ?? 0,
          },
        },
        201,
      );
    }
    return fulfillJson(route, sources);
  });

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/customer/sources');

  await expect(page.getByText('老客转介绍')).toBeVisible();
  // 「门店到访」会出现两次：自己是根来源一行，同时是子来源的「上级」列，取第一个即可。
  await expect(page.getByText('门店到访').first()).toBeVisible();
  // 停用项要看得见、带着「停用」标签，否则页面上再也点不到「启用」。
  await expect(page.getByRole('row', { name: /展会地推/ })).toContainText('停用');
  expect(listUrls.every((url) => url.includes('includeInactive=1'))).toBe(true);

  // 第二行（子来源）的编辑：上级下拉必须锁住，改层级要删掉重建。
  await page
    .getByRole('row', { name: /老客转介绍/ })
    .getByRole('button', { name: /编\s*辑/ })
    .click();
  await expect(page.getByLabel('上级来源')).toBeDisabled();
  await expect(page.getByText('上级来源不支持修改')).toBeVisible();
  await page.getByRole('button', { name: /取\s*消/ }).click();

  await page.getByRole('button', { name: '新建来源' }).click();
  await page.getByLabel('来源名称').fill('小红书');
  await page.getByLabel('上级来源').click();
  await page.locator('.ant-select-dropdown').getByText('门店到访', { exact: true }).click();
  await page.getByRole('button', { name: /保\s*存/ }).click();

  expect(createdBodies).toHaveLength(1);
  expect(createdBodies[0]).toStrictEqual({ name: '小红书', parentId: 'source-root', sortOrder: 0 });
});

/** 财务角色只有 read：入口按钮不该出现，但列表必须能看（单据页面要跳过来核对）。 */
test('财务角色只能看供应商，看不到新建与操作入口', async ({ page }) => {
  await installAuthStub(page, {
    memberships: [{ organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'finance' }],
  });

  await page.route('**/api/suppliers?**', (route) => fulfillJson(route, supplierList));
  await page.route('**/api/suppliers', (route) => fulfillJson(route, supplierList));

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/trade/suppliers');

  await expect(page.getByText('杭州假日酒店')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建供应商' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
  await expect(page.getByText('只读').first()).toBeVisible();
});
