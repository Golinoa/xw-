import { describe, expect, it } from 'vitest';
import { call, OPS_USER, signToken, signServiceToken, USERS } from './harness';

/**
 * `GET /api/v1/ops/meta` 的真实链路验收。
 *
 * 这一组不是「handler 返回了五个字段」的复述：请求打到 Hono，鉴权中间件带着
 * 用户令牌去 PostgREST 调 `ops.get_current_ops_context()`，RPC 再以
 * `authenticated` 身份穿过 `ops.operators` 的 RLS。四段里任何一段配错，
 * 失败形态都不同（401 / 403 / 404 / 42501），所以四条拒绝路径都要各占一条断言。
 */

const OPS_TOKEN = signToken(OPS_USER);

describe('GET /api/v1/ops/meta', () => {
  it('describes the contract to an active operator over the real stack', async () => {
    const response = await call<Record<string, unknown>>('/api/v1/ops/meta', { token: OPS_TOKEN });

    expect(response.status).toBe(200);
    expect(response.body.contractVersion).toBe('1.0.0');
    expect(response.body.timezone).toBe('Asia/Shanghai');
    expect(response.body.supportedSalesModes).toEqual(['saas', 'private']);
    expect(response.body.supportedCurrencies).toEqual(['CNY']);
    expect(String(response.body.serverTime)).toMatch(/Z$/);
  });

  it('answers 401 without a token', async () => {
    const response = await call<{ code: string }>('/api/v1/ops/meta', { token: '' });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  /**
   * 租户成员是这条断言的主角：他们有完全有效的令牌，只是没有 ops.operators 行。
   * 这条同时证明「运营身份不来自令牌里的任何 claim」——令牌里没有、也不该有。
   */
  it('answers 403 for a tenant member who is not an operator', async () => {
    const response = await call<{ code: string }>('/api/v1/ops/meta', {
      token: signToken(USERS.admin),
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  /**
   * service_role 能绕过 RLS，但 `auth.uid()` 为空，RPC 因此返回零行。
   * 这条钉住的是「运营上下文永远绑定到某个人」：即便是基础设施令牌，
   * 也拿不到一个没有 operator 的上下文。
   */
  it('answers 403 for a service-role token with no operator identity', async () => {
    const response = await call<{ code: string }>('/api/v1/ops/meta', {
      token: signServiceToken(),
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('answers 401 for a token signed with another secret', async () => {
    const response = await call<{ code: string }>('/api/v1/ops/meta', {
      token: `${OPS_TOKEN.slice(0, -4)}beef`,
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });
});
