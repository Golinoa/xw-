import { describe, expect, it } from 'vitest';
import { localJwtAuthEnabled, signAccessToken, verifyAccessToken } from './jwt';

const SECRET = 'fixture-jwt-secret';

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function sign(
  payload: Record<string, unknown>,
  options: { secret?: string; algorithm?: string } = {},
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: options.algorithm ?? 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(options.secret ?? SECRET),
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

const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('verifyAccessToken', () => {
  it('returns the subject and session for a valid token', async () => {
    const token = await sign({ sub: 'user-1', session_id: 'session-1', exp: future() });

    await expect(verifyAccessToken(token, SECRET)).resolves.toEqual({
      subject: 'user-1',
      sessionId: 'session-1',
      expiresAt: expect.any(Number),
    });
  });

  /**
   * 这一条是整个改动的前提：access token 会轮换，但同一个人的 sub 不变。
   * 如果验签失败，幂等命名空间就退回令牌哈希，令牌一刷新幂等即失效。
   */
  it('accepts two different tokens for the same subject', async () => {
    const first = await sign({ sub: 'user-1', exp: future(), iat: 1 });
    const second = await sign({ sub: 'user-1', exp: future(), iat: 2 });

    expect(first).not.toBe(second);
    expect((await verifyAccessToken(first, SECRET))?.subject).toBe('user-1');
    expect((await verifyAccessToken(second, SECRET))?.subject).toBe('user-1');
  });

  it('rejects a token signed with another secret', async () => {
    const token = await sign({ sub: 'user-1', exp: future() }, { secret: 'not-the-secret' });

    await expect(verifyAccessToken(token, SECRET)).resolves.toBeNull();
  });

  it('rejects a payload tampered with after signing', async () => {
    const token = await sign({ sub: 'user-1', exp: future() });
    const [header, , signature] = token.split('.');
    const forged = base64url(JSON.stringify({ sub: 'someone-else', exp: future() }));

    await expect(verifyAccessToken(`${header}.${forged}.${signature}`, SECRET)).resolves.toBeNull();
  });

  /**
   * `alg: none` 是 JWT 最古老的绕过手法：把算法声明改成 none 让库跳过验签。
   * 这里只认 HS256，读到头就拒，连签名都不算。
   */
  it('rejects a token that declares no algorithm', async () => {
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = base64url(JSON.stringify({ sub: 'user-1', exp: future() }));

    await expect(verifyAccessToken(`${header}.${body}.`, SECRET)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await sign({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 1 });

    await expect(verifyAccessToken(token, SECRET)).resolves.toBeNull();
  });

  it('rejects a token without a subject', async () => {
    const token = await sign({ exp: future() });

    await expect(verifyAccessToken(token, SECRET)).resolves.toBeNull();
  });

  it('rejects malformed input instead of throwing', async () => {
    for (const value of ['', 'not-a-token', 'a.b', 'a.b.c.d', 'a.!!!.c']) {
      await expect(verifyAccessToken(value, SECRET)).resolves.toBeNull();
    }
  });
});

describe('signAccessToken', () => {
  /**
   * 签发与验签必须是一对。这条用真实往返证明：本地没有 GoTrue 时，
   * 集成测试拿到的令牌确实能被中间件认出来。
   */
  it('produces a token the verifier accepts', async () => {
    const token = await signAccessToken({
      subject: 'user-1',
      sessionId: 'session-1',
      secret: SECRET,
    });

    await expect(verifyAccessToken(token, SECRET)).resolves.toEqual({
      subject: 'user-1',
      sessionId: 'session-1',
      expiresAt: expect.any(Number),
    });
  });

  it('omits session_id when none is given, instead of writing an empty claim', async () => {
    const token = await signAccessToken({ subject: 'user-1', secret: SECRET });

    await expect(verifyAccessToken(token, SECRET)).resolves.toMatchObject({ sessionId: undefined });
  });

  it('rejects its own output under a different secret', async () => {
    const token = await signAccessToken({ subject: 'user-1', secret: 'another-secret' });

    await expect(verifyAccessToken(token, SECRET)).resolves.toBeNull();
  });

  it('honours the ttl it is given', async () => {
    const token = await signAccessToken({ subject: 'user-1', secret: SECRET, ttlSeconds: -1 });

    await expect(verifyAccessToken(token, SECRET)).resolves.toBeNull();
  });
});

describe('localJwtAuthEnabled', () => {
  it('is off unless the flag says exactly true', () => {
    expect(localJwtAuthEnabled({})).toBe(false);
    expect(localJwtAuthEnabled({ ALLOW_LOCAL_JWT_AUTH: '' })).toBe(false);
    // 这些是最容易「看起来关了其实开着」的写法。
    for (const value of ['false', '0', 'no', 'TRUE', 'True', '1', 'yes']) {
      expect(localJwtAuthEnabled({ ALLOW_LOCAL_JWT_AUTH: value })).toBe(false);
    }
    expect(localJwtAuthEnabled({ ALLOW_LOCAL_JWT_AUTH: 'true' })).toBe(true);
  });

  /**
   * 生产也会配 SUPABASE_JWT_SECRET（幂等命名空间要用），所以它不能当开关。
   * 这条把那个决定钉住：即便 secret 在，没有开关也不开本地自签。
   */
  it('ignores the presence of a JWT secret', () => {
    const productionLike = { SUPABASE_JWT_SECRET: SECRET } as { ALLOW_LOCAL_JWT_AUTH?: string };

    expect(localJwtAuthEnabled(productionLike)).toBe(false);
  });
});
