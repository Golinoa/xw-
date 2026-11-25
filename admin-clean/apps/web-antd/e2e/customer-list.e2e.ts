import type { Page } from '@playwright/test';

import {
  customerListResponseSchema,
  customerRecycleBinResponseSchema,
  customerResponseSchema,
  customerTagListResponseSchema,
} from '@erp/contracts';
import { expect, test } from '@playwright/test';

import { fulfillJson, installAuthStub, signIn } from './support/session';

/**
 * 阶段 3.3b：客户列表 / 回收站。
 *
 * 这一批的风险不在「列渲染对不对」，而在三件容易做丢的事：
 * 1. **敏感字段**：列表只能拿到 `*Masked`，详情按权限拿原值。无权限时编辑表单
 *    绝不能把看不见的原号码清掉（请求体里连 `phone` 键都不该出现）。
 * 2. **跨行状态**：勾选 → 批量打标，请求体里的 `customerIds` 必须精确等于勾选行。
 * 3. **失败 ≠ 空数据**：请求挂了不能显示「暂无客户」。
 *
 * 桩全部收在一个 handler 里按 `pathname` 分派：一条 `/api/customers` 的 glob 会把
 * `batch-tags`、`recycle-bin` 与 `/:id` 一起吃掉，分散注册时谁先命中取决于注册顺序，
 * 很容易出现「某个用例悄悄打到真网络」。
 */

const tagFixture = { color: '#1b2a4a', id: 'tag-vip', name: 'VIP' };

const listFixture = customerListResponseSchema.parse({
  items: [
    {
      createdAt: '2026-11-20T02:00:00.000Z',
      emailMasked: 'z***@example.com',
      id: 'customer-1',
      name: '张伟',
      phoneMasked: '138****0001',
      sourceName: '门店到访',
      tags: [tagFixture],
      updatedAt: '2026-11-20T02:00:00.000Z',
    },
    {
      createdAt: '2026-11-19T02:00:00.000Z',
      id: 'customer-2',
      name: '李娜',
      tags: [],
      updatedAt: '2026-11-19T02:00:00.000Z',
    },
  ],
  page: 1,
  pageSize: 15,
  total: 2,
});

/** 无 sensitive 权限时的详情：三处敏感字段都只有掩码，没有原值。 */
const maskedDetail = customerResponseSchema.parse({
  customer: {
    createdAt: '2026-11-20T02:00:00.000Z',
    emailMasked: 'z***@example.com',
    id: 'customer-1',
    idNumberMasked: '3301**********1234',
    name: '张伟',
    phoneMasked: '138****0001',
    sourceId: 'source-off',
    sourceName: '门店到访',
    tags: [tagFixture],
    updatedAt: '2026-11-20T02:00:00.000Z',
    version: 3,
  },
});

const tagList = customerTagListResponseSchema.parse({
  tags: [tagFixture, { id: 'tag-repeat', name: '回头客' }],
});

/** 取「本该存在」的记录：缺失就当场失败，别用 `!` 把 undefined 塞进断言。 */
function mustExist<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`没有记录到 ${label}`);
  return value;
}

type StubOptions = {
  detail?: unknown;
  recycleTotal?: number;
};

/** 装客户相关的全部桩，返回被拦截到的写请求体，供断言。 */
async function installCustomerStub(page: Page, options: StubOptions = {}) {
  const created: Record<string, unknown>[] = [];
  const patched: Record<string, unknown>[] = [];
  const batched: Record<string, unknown>[] = [];
  const listUrls: string[] = [];
  const restored: string[] = [];

  await page.route('**/api/customer-tags**', (route) => {
    if (route.request().method() === 'GET') return fulfillJson(route, tagList);
    return fulfillJson(route, { tag: tagFixture });
  });

  // 客户表单打开时会拉启用中的来源；不放桩会漏到真网络（vite 代理 ECONNREFUSED），
  // 页面看似正常，实际上是「静默失败 ⇒ 下拉为空」。
  await page.route('**/api/customer-sources**', (route) =>
    fulfillJson(route, {
      sources: [
        { id: 'source-off', isActive: false, name: '门店到访', parentId: null, sortOrder: 0 },
        { id: 'source-active', isActive: true, name: '老客转介绍', parentId: null, sortOrder: 1 },
      ],
    }),
  );

  await page.route('**/api/customers**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/api/customers/recycle-bin') {
      const deleted = customerRecycleBinResponseSchema.parse({
        items: [
          {
            createdAt: '2026-11-01T02:00:00.000Z',
            deletedAt: '2026-11-22T08:00:00.000Z',
            id: 'customer-9',
            name: '王芳',
            phoneMasked: '139****0009',
            tags: [],
          },
        ],
        page: 1,
        pageSize: 15,
        total: options.recycleTotal ?? 1,
      });
      return fulfillJson(route, deleted);
    }

    if (url.pathname === '/api/customers/batch-tags') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      batched.push(body);
      return fulfillJson(route, { updatedCustomerIds: body.customerIds });
    }

    const single = /^\/api\/customers\/(?<id>[\w-]+)$/.exec(url.pathname);
    if (single) {
      const id = single.groups?.id ?? '';
      if (method === 'PATCH') {
        const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
        patched.push(body);
        return fulfillJson(route, {
          customer: { ...maskedDetail.customer, name: body.name as string, version: 4 },
        });
      }
      if (method === 'DELETE') return fulfillJson(route, { deletedCustomerId: id });
      return fulfillJson(route, options.detail ?? maskedDetail);
    }

    const restoreMatch = /^\/api\/customers\/(?<id>[\w-]+)\/restore$/.exec(url.pathname);
    if (restoreMatch) {
      const id = restoreMatch.groups?.id ?? '';
      restored.push(id);
      return fulfillJson(route, { restoredCustomerId: id });
    }

    if (url.pathname === '/api/customers') {
      if (method === 'POST') {
        const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
        created.push(body);
        return fulfillJson(
          route,
          {
            customer: { ...maskedDetail.customer, id: 'customer-new', name: body.name as string },
            duplicates: [],
          },
          201,
        );
      }
      listUrls.push(url.href);
      return fulfillJson(route, listFixture);
    }

    // 兜底：宁可让用例红，也不要静默回一个万能响应。
    return fulfillJson(route, { code: 'NOT_STUBBED', message: url.pathname }, 500);
  });

  return { batched, created, listUrls, patched, restored };
}

test('客户列表展示掩码字段，勾选后批量打标只作用于选中的客户', async ({ page }) => {
  await installAuthStub(page);
  const stub = await installCustomerStub(page);

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/customer/list');

  await expect(page.getByText('张伟')).toBeVisible();
  // 列表只能看到掩码：原号码出现在列表上就是越权。
  await expect(page.getByText('138****0001')).toBeVisible();
  await expect(page.getByText('13800000001')).toHaveCount(0);

  await page.getByRole('row', { name: /李娜/ }).getByRole('checkbox').check();
  await expect(page.getByText('已选 1 位客户')).toBeVisible();

  await page.getByRole('button', { name: '批量打标' }).click();
  await page.getByLabel('要添加的标签').click();
  await page.locator('.ant-select-dropdown').getByText('VIP', { exact: true }).click();
  await page.getByRole('button', { name: /应\s*用/ }).click();

  expect(stub.batched).toHaveLength(1);
  expect(stub.batched[0]).toStrictEqual({
    addTagIds: ['tag-vip'],
    customerIds: ['customer-2'],
  });
  await expect(page.getByText('已更新 1 位客户的标签')).toBeVisible();
});

/**
 * 无 `customer.sensitive.read` 时，编辑不能把看不见的原号码清掉。
 *
 * 契约里「缺失 = 不修改」与「null = 清空」是两种意图：表单读不到原值时若把空串
 * 当成「清空」发 `phone: null`，用户只是改了个姓名，手机号就被抹掉了。
 */
test('无敏感字段权限时编辑客户，请求体不带 phone 键', async ({ page }) => {
  await installAuthStub(page);
  const stub = await installCustomerStub(page);

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/customer/list');

  await page.getByRole('button', { name: '张伟' }).click();
  // 抽屉里必须明确标出这是掩码，不能让用户以为是原值。
  await expect(page.getByText('138****0001（掩码）')).toBeVisible();

  await page.getByRole('button', { name: /编\s*辑/ }).click();
  // 客户挂着的来源已被停用：表单必须显示名称 + 「已停用」，不能把原始 UUID 甩给用户。
  await expect(page.getByText('门店到访（已停用）')).toBeVisible();
  await page.getByLabel('姓名').fill('张伟(已核对)');
  await page.getByRole('button', { name: /保\s*存/ }).click();

  expect(stub.patched).toHaveLength(1);
  const body = mustExist(stub.patched[0], '更新请求体');
  expect(body.name).toBe('张伟(已核对)');
  expect(body.version).toBe(3);
  expect('phone' in body).toBe(false);
  expect('email' in body).toBe(false);
  expect('idNumber' in body).toBe(false);
});

test('列表状态来自 URL：页码/排序/关键字都能分享还原', async ({ page }) => {
  await installAuthStub(page);
  const stub = await installCustomerStub(page);

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/customer/list?page=2&pageSize=15&sort=name&order=asc&keyword=%E5%BC%A0');

  await expect(page.getByText('张伟')).toBeVisible();
  const first = new URL(mustExist(stub.listUrls[0], '第一次列表请求'));
  expect(first.searchParams.get('page')).toBe('2');
  expect(first.searchParams.get('sort')).toBe('name');
  expect(first.searchParams.get('order')).toBe('asc');
  expect(first.searchParams.get('keyword')).toBe('张');

  // 契约 keyword 上限 100：超长必须在这里截断，否则请求会被契约整条拒掉，
  // 页面表现为「列表加载失败」——用户根本猜不到是自己输入太长。
  await page
    .getByPlaceholder('搜索姓名、电话或邮箱')
    .fill('王'.repeat(120));
  await page.getByPlaceholder('搜索姓名、电话或邮箱').press('Enter');

  const last = new URL(mustExist(stub.listUrls[stub.listUrls.length - 1], '最后一次列表请求'));
  expect(last.searchParams.get('keyword')).toHaveLength(100);
  expect(last.searchParams.get('page')).toBe('1');
});

test('新建客户只发填过的字段，标签空数组表示不打标', async ({ page }) => {
  await installAuthStub(page);
  const stub = await installCustomerStub(page);

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/customer/list');

  await page.getByRole('button', { name: '新建客户' }).click();
  await page.getByLabel('姓名').fill('赵敏');
  await page.getByRole('button', { name: /保\s*存/ }).click();

  expect(stub.created).toHaveLength(1);
  expect(stub.created[0]).toStrictEqual({ name: '赵敏', tagIds: [] });
});

/** 财务角色只有 customer.read：能看列表，但没有任何写入口，也进不了回收站。 */
test('财务角色只能看客户，看不到新建/标签管理/回收站入口', async ({ page }) => {
  await installAuthStub(page, {
    memberships: [{ organizationId: 'org-alpha', organizationName: 'Alpha Travel', role: 'finance' }],
  });
  await installCustomerStub(page);

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/customer/list');

  await expect(page.getByText('张伟')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建客户' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '标签管理' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '回收站' })).toHaveCount(0);

  await page.goto('/customer/recycle');
  await expect(page.getByText('当前账号没有客户恢复权限，无法查看回收站。')).toBeVisible();
});

test('回收站能恢复客户并刷新列表', async ({ page }) => {
  await installAuthStub(page);
  const stub = await installCustomerStub(page);

  await page.goto('/auth/login');
  await signIn(page);
  await page.goto('/customer/recycle');

  await expect(page.getByText('王芳')).toBeVisible();
  await expect(page.getByText('2026/11/22')).toBeVisible();

  await page.getByRole('button', { name: /恢\s*复/ }).first().click();
  await page.locator('.ant-popover').getByRole('button', { name: /恢\s*复/ }).click();

  expect(stub.restored).toStrictEqual(['customer-9']);
  await expect(page.getByText('已恢复客户「王芳」')).toBeVisible();
});
