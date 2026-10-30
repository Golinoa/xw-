import { describe, expect, it } from 'vitest';
import { idempotencyStorageKey } from '../../apps/api/src/lib/idempotency-key';
import {
  ORG_ID,
  REST_URL,
  USERS,
  call,
  expectStatus,
  restRequest,
  signServiceToken,
  signToken,
} from './harness';

/**
 * 幂等在真实链路里的行为。
 *
 * 与 `idempotency.test.ts` 的分工：单测证明「某个 store 的语义对」，这里证明
 * 「接上 PostgREST 之后语义还对」——包括存储 key 的派生、`Accept-Profile` /
 * `Content-Profile` 的选择、以及 service_role 能不能写进 `ops` 表。
 * 这三件事分开看都容易过，接在一起才是运营契约 §2.5 要求的东西。
 */

const SERVICE_TOKEN = signServiceToken();
const PATH = '/api/customers';

interface CustomerBody {
  name: string;
  phone?: string;
}

function customerName(suffix: string): string {
  return `幂等验证-${suffix}`;
}

describe('idempotent writes through PostgREST', () => {
  it('replays a repeated write instead of creating a second record', async () => {
    const token = signToken(USERS.admin);
    const idempotencyKey = crypto.randomUUID();
    const body: CustomerBody = { name: customerName(idempotencyKey.slice(0, 8)) };

    const first = await call<{ id: string }>(PATH, {
      method: 'POST',
      body,
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    expectStatus(first, 201);

    const second = await call<{ id: string }>(PATH, {
      method: 'POST',
      body,
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
    });

    // 重放保留原始状态码与响应体：调用方看到的是「同一次成功的写入」。
    expectStatus(second, 201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get('idempotent-replay')).toBe('true');

    // 库里只有一条记录，且它的 scope_key 必须就是中间件算出来的那个。
    // 这条断言把「派生算法」与「落库内容」绑在一起：两边各自改了都不会被发现，
    // 只有它们对不上时才会红。
    const expectedScopeKey = await idempotencyStorageKey({
      authorization: `Bearer ${token}`,
      organizationId: ORG_ID,
      method: 'POST',
      path: PATH,
      key: idempotencyKey,
    });
    const rows = await restRequest<{ scope_key: string; status: number }[]>(
      `idempotency_records?scope_key=eq.${encodeURIComponent(expectedScopeKey)}&select=scope_key,status`,
      { profile: 'ops', token: SERVICE_TOKEN },
    );
    expectStatus(rows, 200);
    expect(rows.body).toHaveLength(1);
    expect(rows.body[0]?.status).toBe(201);
  });

  it('answers 409 when the same key carries a different body', async () => {
    const token = signToken(USERS.admin);
    const idempotencyKey = crypto.randomUUID();

    const first = await call(PATH, {
      method: 'POST',
      body: { name: customerName('first') },
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    expectStatus(first, 201);

    const conflict = await call<{ code: string }>(PATH, {
      method: 'POST',
      body: { name: customerName('second') },
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
    });

    expectStatus(conflict, 409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('does not replay across different endpoints', async () => {
    // 修复前这里会拿到另一端点（建客户）的响应体，看起来像建成功了。
    const token = signToken(USERS.admin);
    const idempotencyKey = crypto.randomUUID();

    const customer = await call<{ customer: { id: string } }>(PATH, {
      method: 'POST',
      body: { name: customerName('cross-endpoint') },
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    expectStatus(customer, 201);

    const supplier = await call<{ supplier: { id: string }; customer?: unknown }>(
      '/api/suppliers',
      {
        method: 'POST',
        body: { name: customerName('supplier'), type: 'hotel', settlement: 'monthly' },
        token,
        headers: { 'Idempotency-Key': idempotencyKey },
      },
    );

    expectStatus(supplier, 201);
    expect(supplier.headers.get('idempotent-replay')).toBeNull();
    // 最锋利的一条：客户响应体里有 customer 没有 supplier。
    // 若被跨端点重放，这里是 customer 而不是 supplier，且 status 仍是 201。
    expect(supplier.body).not.toHaveProperty('customer');
    expect(supplier.body.supplier.id).not.toBe(customer.body.customer.id);
  });

  it('keeps the records table closed to a normal user token', async () => {
    // 幂等记录里存的是别人的响应体。API 用 service_role 读写，客户端令牌
    // 连 schema 的 USAGE 都没有——这条边界属于「一旦破了没人会发现」的那类。
    const rows = await restRequest('idempotency_records?select=scope_key', {
      profile: 'ops',
      token: signToken(USERS.admin),
    });

    expect(rows.status).toBeGreaterThanOrEqual(400);
    expect(REST_URL).toContain('127.0.0.1');
  });
});
