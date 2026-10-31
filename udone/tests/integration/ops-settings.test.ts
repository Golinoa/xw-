import { describe, expect, it } from 'vitest';
import { OPS_SALES_USER, OPS_USER, call, expectStatus, signToken } from './harness';

/**
 * 设置页的集成测试：真实 PostgREST + 真实 RPC + 真实 RLS。
 *
 * 这一层要证明的是**两道权限的边界不是同一个**，以及「改完能读回来」：
 *
 * - 参数项（读与写）都要 `settings.manage`：`sales_ops` 没有，平台管理员有。
 * - 字典的读对「任意已认证运营成员」开放：`sales_ops` 读得到，写不了。
 *
 * 只测管理员一侧会把「下拉框被锁给管理员」当成正常——那正是契约 §5.9 唯一
 * 明确放开的一条。
 *
 * 只改 `exportRetentionDays`：另外两个参数项被总览（临期窗口）与工单
 * （内部时限）实时读着，并行跑时改它们会让别的文件看到中间值。这一条也顺带
 * 说明为什么参数项要能单独改——三个人同时改三项，互不覆盖。
 */

const SETTINGS = '/api/v1/ops/settings';
const DICTIONARIES = '/api/v1/ops/dictionaries';

const adminToken = signToken(OPS_USER);
const salesToken = signToken(OPS_SALES_USER);

interface SettingsBody {
  settings: {
    overviewExpiryWindowDays: number;
    ticketDueHours: number;
    exportRetentionDays: number;
  };
  updatedBy: { id: string; displayName: string } | null;
  updatedAt: string | null;
}

interface DictionaryBody {
  items: Array<{
    code: string;
    name: string;
    items: Array<{
      id: string;
      value: string;
      label: string;
      sortOrder: number;
      isActive: boolean;
    }>;
  }>;
}

describe('GET /api/v1/ops/settings', () => {
  it('returns the three settings with an operator object for updatedBy', async () => {
    const response = await call<SettingsBody>(SETTINGS, { token: adminToken });

    expectStatus(response, 200);
    expect(response.body.settings.overviewExpiryWindowDays).toBeGreaterThanOrEqual(1);
    expect(response.body.settings.ticketDueHours).toBeLessThanOrEqual(720);
    // updatedBy 要么是 {id,displayName}，要么是 null；永远不是裸 uuid 字符串。
    if (response.body.updatedBy !== null) {
      expect(typeof response.body.updatedBy).toBe('object');
      expect(response.body.updatedBy.displayName.length).toBeGreaterThan(0);
    }
  });

  it('forbids a caller without settings.manage', async () => {
    const response = await call(SETTINGS, { token: salesToken });

    expectStatus(response, 403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('PATCH /api/v1/ops/settings', () => {
  it('writes one key, reads it back, and leaves the others alone', async () => {
    const before = await call<SettingsBody>(SETTINGS, { token: adminToken });
    expectStatus(before, 200);

    const patched = await call<SettingsBody>(SETTINGS, {
      method: 'PATCH',
      token: adminToken,
      body: { exportRetentionDays: 120 },
    });
    expectStatus(patched, 200);
    expect(patched.body.settings.exportRetentionDays).toBe(120);
    // 另外两项原样：只传一个键的请求不该把没传的写回默认值。
    expect(patched.body.settings.overviewExpiryWindowDays).toBe(
      before.body.settings.overviewExpiryWindowDays,
    );
    expect(patched.body.settings.ticketDueHours).toBe(before.body.settings.ticketDueHours);
    expect(patched.body.updatedBy?.displayName.length).toBeGreaterThan(0);

    const reread = await call<SettingsBody>(SETTINGS, { token: adminToken });
    expectStatus(reread, 200);
    expect(reread.body.settings.exportRetentionDays).toBe(120);

    // 复原：这个值别的文件不读，但留下 120 会让「设置的默认值」在手工排查时对不上。
    const restored = await call<SettingsBody>(SETTINGS, {
      method: 'PATCH',
      token: adminToken,
      body: { exportRetentionDays: before.body.settings.exportRetentionDays },
    });
    expectStatus(restored, 200);
  });

  it('requires an Idempotency-Key', async () => {
    const response = await call(SETTINGS, {
      method: 'PATCH',
      token: adminToken,
      body: { exportRetentionDays: 120 },
      omitIdempotencyKey: true,
    });

    expectStatus(response, 400);
    expect(response.body).toMatchObject({ details: { field: 'Idempotency-Key' } });
  });

  it('forbids a caller without settings.manage', async () => {
    const response = await call(SETTINGS, {
      method: 'PATCH',
      token: salesToken,
      body: { exportRetentionDays: 120 },
    });

    expectStatus(response, 403);
  });
});

describe('GET /api/v1/ops/dictionaries', () => {
  it('is readable without settings.manage', async () => {
    const response = await call<DictionaryBody>(DICTIONARIES, { token: salesToken });

    expectStatus(response, 200);
    expect(response.body.items.length).toBeGreaterThanOrEqual(2);
    // 条目按 sortOrder 排：前端下拉照这个顺序渲染，不自己再排。
    const payment = response.body.items.find((entry) => entry.code === 'payment_methods');
    expect(payment?.items.length).toBeGreaterThan(0);
    const orders = payment?.items.map((entry) => entry.sortOrder) ?? [];
    expect([...orders].sort((left, right) => left - right)).toEqual(orders);
  });

  it('narrows by code', async () => {
    const response = await call<DictionaryBody>(DICTIONARIES, {
      token: salesToken,
      query: { code: 'ticket_issue_types' },
    });

    expectStatus(response, 200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]?.code).toBe('ticket_issue_types');
  });
});

describe('POST /api/v1/ops/dictionaries/:code/items', () => {
  it('creates an item, then refuses the same value twice', async () => {
    const created = await call<{ item: { id: string; value: string; label: string } }>(
      `${DICTIONARIES}/payment_methods/items`,
      {
        method: 'POST',
        token: adminToken,
        body: { value: 'wire_transfer', label: '电汇' },
      },
    );
    expectStatus(created, 200);
    expect(created.body.item.value).toBe('wire_transfer');

    const duplicate = await call(`${DICTIONARIES}/payment_methods/items`, {
      method: 'POST',
      token: adminToken,
      body: { value: 'wire_transfer', label: '电汇（重复）' },
    });
    // 409 而不是覆盖：覆盖会让「历史行回显的 label 变了」，而那些行存的是 value。
    expectStatus(duplicate, 409);
    expect(duplicate.body).toMatchObject({ details: { reason: 'DUPLICATE_VALUE' } });
  });

  it('forbids a caller without settings.manage', async () => {
    const response = await call(`${DICTIONARIES}/payment_methods/items`, {
      method: 'POST',
      token: salesToken,
      body: { value: 'cash', label: '现金' },
    });

    expectStatus(response, 403);
  });

  it('turns an unknown dictionary code into 404', async () => {
    const response = await call(`${DICTIONARIES}/no_such_dictionary/items`, {
      method: 'POST',
      token: adminToken,
      body: { value: 'x', label: 'X' },
    });

    expectStatus(response, 404);
  });
});

describe('PATCH /api/v1/ops/dictionary-items/:itemId', () => {
  it('rewrites the label and keeps the stored value', async () => {
    const list = await call<DictionaryBody>(DICTIONARIES, {
      token: adminToken,
      query: { code: 'payment_methods' },
    });
    expectStatus(list, 200);

    const target = list.body.items[0]?.items.find((entry) => entry.value === 'wire_transfer');
    expect(target).toBeDefined();

    const updated = await call<{ item: { value: string; label: string } }>(
      `/api/v1/ops/dictionary-items/${target?.id}`,
      { method: 'PATCH', token: adminToken, body: { label: '电汇（对公）' } },
    );
    expectStatus(updated, 200);
    expect(updated.body.item.label).toBe('电汇（对公）');
    expect(updated.body.item.value).toBe('wire_transfer');
  });

  it('turns an unknown item id into 404', async () => {
    const response = await call(
      '/api/v1/ops/dictionary-items/00000000-0000-4000-8000-0000000000ff',
      {
        method: 'PATCH',
        token: adminToken,
        body: { label: 'x' },
      },
    );

    expectStatus(response, 404);
  });
});
