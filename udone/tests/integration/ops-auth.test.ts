import { describe, expect, it } from 'vitest';
import { call, OPS_DISABLED_USER, OPS_USER, signToken, USERS } from './harness';
import type { OpsAuthUpstream } from '../../apps/api/src/modules/ops/auth/upstream';

/**
 * 登录三端点的验收，**分成两段**，结论也分两段写：
 *
 * - **密码校验是替身**：本地没有 GoTrue（`db:local:*` 只起 PostgREST），
 *   `OPS_AUTH_UPSTREAM` 是注入的假实现。这一段证明的是「拿到令牌之后我们做对了什么」，
 *   不证明「GoTrue 会认这个密码」。
 * - **成员判定是真的**：登录后的 `ops.login_member_state()` 打到真实 PostgREST，
 *   以 `authenticated` 身份穿过 RLS，返回的状态来自 `ops.operators` 的行。
 *   403 的两个 reason 都是从库里查出来的，不是替身编的。
 *
 * 合成一句「登录已验证」会把上面两段的差异抹掉，而差异恰好是风险所在。
 */

function upstreamReturning(userId: string): OpsAuthUpstream {
  return {
    async signInWithPassword() {
      return { kind: 'granted', accessToken: signToken(userId), refreshToken: `refresh-${userId}` };
    },
    async refresh() {
      return { kind: 'granted', accessToken: signToken(userId), refreshToken: `rotated-${userId}` };
    },
    async revoke() {},
  };
}

describe('POST /api/v1/ops/auth/login', () => {
  it('hands an active operator a token that works on the next endpoint', async () => {
    const login = await call<{ accessToken: string }>('/api/v1/ops/auth/login', {
      method: 'POST',
      token: '',
      body: { email: 'ops-admin@integration.test', password: 'any-password' },
      env: { OPS_AUTH_UPSTREAM: upstreamReturning(OPS_USER) },
    });

    expect(login.status).toBe(200);
    expect(Object.keys(login.body)).toEqual(['accessToken']);
    expect(login.headers.get('set-cookie')).toContain('ops_refresh=');

    // 令牌是这一跳的产物，直接拿它去打下一个端点：如果登录发了张 PostgREST
    // 不认的票，这条会红，而只断言「响应里有 accessToken」是发现不了的。
    const meta = await call<{ contractVersion: string }>('/api/v1/ops/meta', {
      token: login.body.accessToken,
    });
    expect(meta.status).toBe(200);
  });

  it('answers 403 OPS_MEMBER_MISSING for a tenant member, with no cookie', async () => {
    const response = await call<{ code: string; details?: { reason?: string } }>(
      '/api/v1/ops/auth/login',
      {
        method: 'POST',
        token: '',
        body: { email: 'admin@integration.test', password: 'any-password' },
        env: { OPS_AUTH_UPSTREAM: upstreamReturning(USERS.admin) },
      },
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect(response.body.details?.reason).toBe('OPS_MEMBER_MISSING');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('answers 403 OPS_MEMBER_INACTIVE for a disabled operator, with no cookie', async () => {
    const response = await call<{ code: string; details?: { reason?: string } }>(
      '/api/v1/ops/auth/login',
      {
        method: 'POST',
        token: '',
        body: { email: 'ops-disabled@integration.test', password: 'any-password' },
        env: { OPS_AUTH_UPSTREAM: upstreamReturning(OPS_DISABLED_USER) },
      },
    );

    expect(response.status).toBe(403);
    expect(response.body.details?.reason).toBe('OPS_MEMBER_INACTIVE');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  /**
   * 这两条 403 的区别不是措辞，而是「该找谁」：MISSING 要人开户，INACTIVE 要人恢复。
   * 合成一条 FORBIDDEN 的话，两种人都会被告知「去问管理员」，而管理员打开列表
   * 看到的是另一回事。上面两条断言各自钉住一个 reason，就是为了不让它们退化成一条。
   */
  it('answers 401 when the upstream rejects the password', async () => {
    const response = await call<{ code: string }>('/api/v1/ops/auth/login', {
      method: 'POST',
      token: '',
      body: { email: 'ops-admin@integration.test', password: 'wrong' },
      env: {
        OPS_AUTH_UPSTREAM: {
          ...upstreamReturning(OPS_USER),
          async signInWithPassword() {
            return { kind: 'rejected' } as const;
          },
        },
      },
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/v1/ops/auth/refresh', () => {
  it('rotates the cookie and returns a usable token', async () => {
    const response = await call<{ accessToken: string }>('/api/v1/ops/auth/refresh', {
      method: 'POST',
      token: '',
      headers: { Cookie: 'ops_refresh=refresh-current' },
      env: { OPS_AUTH_UPSTREAM: upstreamReturning(OPS_USER) },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('ops_refresh=rotated-');

    const meta = await call('/api/v1/ops/meta', { token: response.body.accessToken });
    expect(meta.status).toBe(200);
  });

  it('answers 401 without a cookie', async () => {
    const response = await call<{ code: string }>('/api/v1/ops/auth/refresh', {
      method: 'POST',
      token: '',
      env: { OPS_AUTH_UPSTREAM: upstreamReturning(OPS_USER) },
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });
});

describe('POST /api/v1/ops/auth/logout', () => {
  it('answers 204 and expires the cookie', async () => {
    const response = await call('/api/v1/ops/auth/logout', {
      method: 'POST',
      token: '',
      headers: { Cookie: 'ops_refresh=refresh-current' },
      env: { OPS_AUTH_UPSTREAM: upstreamReturning(OPS_USER) },
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
