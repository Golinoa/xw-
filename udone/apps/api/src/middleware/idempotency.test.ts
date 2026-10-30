import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryIdempotencyStore } from '../lib/idempotency-store';
import type { ApiEnvironment } from './auth';
import { errorHandler } from './error-handler';
import { idempotency } from './idempotency';

function buildApp(handler: (body: unknown) => Response | Promise<Response>) {
  const calls = vi.fn();
  const app = new Hono<ApiEnvironment>();
  app.onError(errorHandler);
  app.use('*', idempotency({ store: createMemoryIdempotencyStore() }));
  app.post('/api/invitations', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    calls(body);
    return handler(body);
  });
  // 第二个写端点，用来验证 key 不会跨端点命中。
  app.post('/api/orders', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    calls(body);
    return handler(body);
  });
  app.get('/api/invitations', (context) => {
    calls({ read: true });
    return context.json({ read: true });
  });
  return { app, calls };
}

const VALID_KEY = 'idem-key-0001';

function post(
  app: Hono<ApiEnvironment>,
  path: string,
  options: {
    key?: string;
    body?: unknown;
    authorization?: string;
    env?: ApiEnvironment['Bindings'];
  } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.key) headers['Idempotency-Key'] = options.key;
  if (options.authorization) headers.Authorization = options.authorization;
  return app.request(
    path,
    {
      method: 'POST',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    // 第三个参数是 env：验签需要 SUPABASE_JWT_SECRET，不传时 context.env 是
    // undefined，中间件会退化为令牌哈希命名空间。
    options.env,
  );
}

const JWT_SECRET = 'fixture-jwt-secret';

/**
 * 用 WebCrypto 签，不用 `node:crypto`：这个包只装了
 * `@cloudflare/workers-types`，`node:crypto` 的模块声明不存在，`tsc` 会直接失败。
 * 而中间件本身就跑在 Worker 里，用同一套 API 更贴近运行环境。
 */
async function signToken(
  subject: string,
  options: { issuedAt?: number; secret?: string; expiresIn?: number } = {},
): Promise<string> {
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = encode(
    JSON.stringify({
      sub: subject,
      iat: options.issuedAt ?? now,
      exp: now + (options.expiresIn ?? 3600),
    }),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(options.secret ?? JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${Buffer.from(signature).toString('base64url')}`;
}

describe('idempotency middleware', () => {
  it('replays the first response instead of running the handler twice', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(() => Response.json({ id: `invitation-${++sequence}` }));

    const first = await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'invitee@example.com' },
    });
    const second = await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'invitee@example.com' },
    });

    expect(calls).toHaveBeenCalledTimes(1);
    // 中间件为了算指纹克隆读过请求体；这里必须确认路由仍然拿得到原始 body。
    // 少了这条，请求体被中间件吃掉、路由只收到 {} 也照样「通过」。
    expect(calls).toHaveBeenCalledWith({ email: 'invitee@example.com' });
    expect(await first.json()).toEqual({ id: 'invitation-1' });
    expect(await second.json()).toEqual({ id: 'invitation-1' });
    expect(second.headers.get('idempotent-replay')).toBe('true');
  });

  it('runs the handler again when the key differs', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(() => Response.json({ id: `invitation-${++sequence}` }));

    await post(app, '/api/invitations', { key: VALID_KEY });
    await post(app, '/api/invitations', { key: 'idem-key-0002' });

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed key before the handler runs', async () => {
    const { app, calls } = buildApp(() => Response.json({ ok: true }));

    const response = await post(app, '/api/invitations', { key: 'short' });

    expect(response.status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });

  it('does not cache a failing response', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(
      () => new Response(JSON.stringify({ message: 'nope' }), { status: 409 }),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      sequence += 1;
      await post(app, '/api/invitations', { key: VALID_KEY });
    }

    expect(sequence).toBe(2);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('ignores the key on safe methods', async () => {
    const { app, calls } = buildApp(() => Response.json({ ok: true }));

    await app.request('/api/invitations', { headers: { 'Idempotency-Key': VALID_KEY } });
    await app.request('/api/invitations', { headers: { 'Idempotency-Key': VALID_KEY } });

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('passes through when no key is supplied', async () => {
    const { app, calls } = buildApp(() => Response.json({ ok: true }));

    await post(app, '/api/invitations');
    await post(app, '/api/invitations');

    expect(calls).toHaveBeenCalledTimes(2);
  });

  /**
   * 以下三条都是修复前会「静默成功」的形态：请求返回 200，但做的是错的事。
   * 它们不是边界情况，客户端不生成随机 key（例如把订单号当 key）就会撞上。
   */
  it('does not replay a key across different endpoints', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(() => Response.json({ id: `created-${++sequence}` }));

    const invitation = await post(app, '/api/invitations', { key: VALID_KEY, body: { a: 1 } });
    const order = await post(app, '/api/orders', { key: VALID_KEY, body: { a: 1 } });

    expect(calls).toHaveBeenCalledTimes(2);
    expect(await invitation.json()).toEqual({ id: 'created-1' });
    // 修复前这里拿到的是 invitations 的响应体，客户端会以为订单建成了。
    expect(await order.json()).toEqual({ id: 'created-2' });
    expect(order.headers.get('idempotent-replay')).toBeNull();
  });

  it('does not replay a key across callers', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(() => Response.json({ id: `created-${++sequence}` }));

    const alice = await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'a@example.com' },
      authorization: 'Bearer token-alice',
    });
    const bob = await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'a@example.com' },
      authorization: 'Bearer token-bob',
    });

    expect(calls).toHaveBeenCalledTimes(2);
    expect(await alice.json()).toEqual({ id: 'created-1' });
    // 修复前 Bob 会收到 Alice 的响应，连同 Alice 的 id。
    expect(await bob.json()).toEqual({ id: 'created-2' });
  });

  it('rejects a reused key whose body changed', async () => {
    const { app, calls } = buildApp(() => Response.json({ ok: true }));

    await post(app, '/api/invitations', { key: VALID_KEY, body: { amount: 100 } });
    const conflict = await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { amount: 900 },
    });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // 换 key 才是正确做法；同一个 key 再执行一次会让金额翻倍。
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe('caller identity across token refreshes', () => {
  /**
   * 这是 3df4fe2 遗留的缺陷：命名空间用 sha256(Authorization)，令牌一刷新哈希
   * 就变。而幂等最该生效的场景恰恰是「网关超时 → 客户端重试」，这段间隔里
   * access token 完全可能过期并轮换。收款端点会因此重复记账。
   */
  it('replays the same response after the access token is refreshed', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(() => Response.json({ id: `invitation-${++sequence}` }));
    const env = { SUPABASE_JWT_SECRET: JWT_SECRET };

    const before = await signToken('operator-1', { issuedAt: 1 });
    const after = await signToken('operator-1', { issuedAt: 2 });
    expect(before).not.toBe(after);

    const first = await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'invitee@example.com' },
      authorization: `Bearer ${before}`,
      env,
    });
    const second = await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'invitee@example.com' },
      authorization: `Bearer ${after}`,
      env,
    });

    expect(calls).toHaveBeenCalledTimes(1);
    expect(await first.json()).toEqual({ id: 'invitation-1' });
    expect(await second.json()).toEqual({ id: 'invitation-1' });
    expect(second.headers.get('idempotent-replay')).toBe('true');
  });

  /**
   * 退化路径不能变成漏洞：伪造的令牌验不过签名，只能落到自己的哈希命名空间，
   * 不会命中真用户那一格。否则任何人都能用一个伪造的 sub 让别人收到不属于
   * 自己的成功响应。
   */
  it('does not let a forged token share a namespace with the real caller', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(() => Response.json({ id: `invitation-${++sequence}` }));
    const env = { SUPABASE_JWT_SECRET: JWT_SECRET };

    await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'invitee@example.com' },
      authorization: `Bearer ${await signToken('operator-1')}`,
      env,
    });
    const forged = await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'invitee@example.com' },
      authorization: `Bearer ${await signToken('operator-1', { secret: 'wrong-secret' })}`,
      env,
    });

    expect(calls).toHaveBeenCalledTimes(2);
    expect(forged.headers.get('idempotent-replay')).toBeNull();
  });

  it('still isolates different subjects that share a key', async () => {
    const { app, calls } = buildApp(() => Response.json({ id: 'created' }));
    const env = { SUPABASE_JWT_SECRET: JWT_SECRET };

    await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'invitee@example.com' },
      authorization: `Bearer ${await signToken('operator-1')}`,
      env,
    });
    await post(app, '/api/invitations', {
      key: VALID_KEY,
      body: { email: 'invitee@example.com' },
      authorization: `Bearer ${await signToken('operator-2')}`,
      env,
    });

    expect(calls).toHaveBeenCalledTimes(2);
  });
});
