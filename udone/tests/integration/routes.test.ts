import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

/**
 * 线路主数据，跑在真实 PostgREST 上。
 *
 * 这一层要证明三件 pgTAP 与单测都证明不了的事：
 * 1. `created_by` 的默认值 `auth.uid()` 在真实 JWT 下真的取到人（插入策略要求它等于调用者）；
 * 2. 组织内重名唯一索引的 23505 被 PostgREST 转成 409，而不是落到 500；
 * 3. `PATCH` / `DELETE` 用 `Prefer: return=representation` 能拿回行，
 *    否则「改成功了但接口说 404」这种错只会在线上出现。
 *
 * 线路名带随机后缀：集成库在多次运行之间可能被复用，写死名字会在第二次运行时撞唯一索引。
 */

const suffix = Math.random().toString(36).slice(2, 8);
const routeName = `集成线路-${suffix}`;
const renamed = `集成线路-${suffix}-改`;

interface RouteBody {
  id: string;
  name: string;
  routeType?: string;
  region?: string;
  days?: number;
  isSelfGroup: boolean;
  isActive: boolean;
}

describe('route master data over HTTP', () => {
  let routeId = '';

  it('creates a route and fills created_by from the caller', async () => {
    const response = await call<{ route: RouteBody }>('/api/routes', {
      method: 'POST',
      body: { name: routeName, routeType: '境内跟团', days: 6, isSelfGroup: true },
    });

    expectStatus(response, 201);
    expect(response.body.route).toMatchObject({
      name: routeName,
      routeType: '境内跟团',
      days: 6,
      isSelfGroup: true,
      isActive: true,
    });
    routeId = response.body.route.id;
  });

  it('lists the new route for the same organization', async () => {
    const response = await call<{ items: RouteBody[]; total: number }>('/api/routes', {
      query: { keyword: suffix, pageSize: '20' },
    });

    expectStatus(response, 200);
    expect(response.body.items.map((item) => item.name)).toContain(routeName);
  });

  it('reports a duplicate name as 409 instead of 500', async () => {
    const response = await call<{ code: string }>('/api/routes', {
      method: 'POST',
      body: { name: routeName },
    });

    expectStatus(response, 409);
    expect(response.body.code).toBe('CONFLICT');
  });

  it('renames without touching the other fields', async () => {
    const response = await call<{ route: RouteBody }>(`/api/routes/${routeId}`, {
      method: 'PATCH',
      body: { name: renamed },
    });

    expectStatus(response, 200);
    expect(response.body.route).toMatchObject({ name: renamed, days: 6, routeType: '境内跟团' });
  });

  it('lets finance read but not write', async () => {
    const read = await call('/api/routes', { actor: 'finance', query: { pageSize: '10' } });
    expectStatus(read, 200);

    const write = await call<{ code: string }>('/api/routes', {
      actor: 'finance',
      method: 'POST',
      body: { name: `财务不能建-${suffix}` },
    });
    expectStatus(write, 403);
    expect(write.body.code).toBe('FORBIDDEN');
  });

  it('deletes the route and then reports 404 for the same id', async () => {
    const first = await call<{ deletedRouteId: string }>(`/api/routes/${routeId}`, {
      method: 'DELETE',
    });
    expectStatus(first, 200);
    expect(first.body.deletedRouteId).toBe(routeId);

    // 第二次删除拿不到行：区分「删成功」与「本来就不存在」是 404 的唯一用途。
    const second = await call(`/api/routes/${routeId}`, { method: 'DELETE' });
    expectStatus(second, 404);
  });
});
