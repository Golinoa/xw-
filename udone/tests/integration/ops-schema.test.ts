import { describe, expect, it } from 'vitest';
import { expectStatus, restRequest, signServiceToken, signToken, USERS } from './harness';

/**
 * `ops` schema 的暴露与权限边界。
 *
 * 这一组断言对着的是三处配置里的同一件事：`supabase/config.toml` 的
 * `[api] schemas`、本地 harness 的 `db-schemas`、以及 rest-client 发的
 * profile 头。任缺一处，运营端所有表在真实链路里都读不到——而失败形态
 * 分别是 406、404、读到了 public 里的同名表，三种看起来都跟配置无关。
 */

const SERVICE_TOKEN = signServiceToken();

/** request_hash 有 CHECK (length = 64)，用真实长度的十六进制串。 */
const HASH = 'a'.repeat(64);

function uniqueScope(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe('ops schema exposure', () => {
  it('lets service_role write and read through the ops profile', async () => {
    const scopeKey = uniqueScope('service');

    const created = await restRequest<{ scope_key: string }[]>('idempotency_records', {
      method: 'POST',
      profile: 'ops',
      token: SERVICE_TOKEN,
      prefer: 'return=representation',
      body: {
        scope_key: scopeKey,
        request_hash: HASH,
        status: 201,
        body: { id: 'replayed-response' },
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expectStatus(created, 201);
    expect(created.body[0]?.scope_key).toBe(scopeKey);

    const read = await restRequest<{ scope_key: string; status: number }[]>(
      `idempotency_records?scope_key=eq.${encodeURIComponent(scopeKey)}`,
      { profile: 'ops', token: SERVICE_TOKEN },
    );
    expectStatus(read, 200);
    expect(read.body).toHaveLength(1);
    expect(read.body[0]?.status).toBe(201);
  });

  it('refuses the table when no profile is given', async () => {
    // 不带 profile 时 PostgREST 用配置里的第一个 schema（public）。
    // 这条同时证明「表不在 public」与「profile 头是必需的」。
    const response = await restRequest('idempotency_records', { token: SERVICE_TOKEN });

    expectStatus(response, 404);
    expect(response.body).toMatchObject({ code: 'PGRST205' });
  });

  it('denies a normal user token even with the right profile', async () => {
    // service_role 靠 BYPASSRLS 通过；authenticated 连 schema 的 USAGE 都没有。
    // 这一条是「幂等记录不会泄漏别人的响应体」的直接证据。
    const response = await restRequest('idempotency_records', {
      profile: 'ops',
      token: signToken(USERS.admin),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = response.body as { code?: string; message?: string };
    expect(body.code ?? '').toBe('42501');
    expect(body.message ?? '').toContain('permission denied');
  });

  it('rejects a row whose request_hash is not a sha256 digest', async () => {
    // 长度约束是数据面的保险：写入端算错了哈希，宁可插入失败，
    // 也不要在回放时把两个不同的请求当成同一个。
    const response = await restRequest('idempotency_records', {
      method: 'POST',
      profile: 'ops',
      token: SERVICE_TOKEN,
      body: {
        scope_key: uniqueScope('short-hash'),
        request_hash: 'too-short',
        status: 200,
        body: {},
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
