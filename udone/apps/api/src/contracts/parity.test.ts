import { describe, expect, it } from 'vitest';
import { z } from '@erp/contracts';
import { compareRegistries, type RouteRegistries } from './parity';

/**
 * 对账函数的自测。
 *
 * 这些断言存在的理由：`route-parity.test.ts` 在真实数据上只会返回「四个空数组」，
 * 而一个恒返回空数组的函数也能让那条断言通过。下面每条都是「喂一份坏数据，
 * 它必须点名」——这才证明门禁是门禁，不是装饰。
 */

const response = z.object({ ok: z.boolean() });
const route = (method: 'GET' | 'POST', path: string) => ({ method, path, response });

function registries(overrides: RouteRegistries = {}): RouteRegistries {
  return {
    ROUTES: { health: route('GET', '/api/health') },
    OPS_ROUTES: {},
    ...overrides,
  };
}

describe('compareRegistries', () => {
  it('reports nothing when everything agrees', () => {
    const report = compareRegistries({
      registered: ['GET /api/health'],
      registries: registries(),
      requiredPrefix: { OPS_ROUTES: '/api/v1/ops' },
    });

    expect(report).toEqual({ unmounted: [], undeclared: [], duplicateKeys: [], misplaced: [] });
  });

  it('names a declared route that was never mounted', () => {
    const report = compareRegistries({
      registered: [],
      registries: registries(),
    });

    expect(report.unmounted).toEqual(['GET /api/health']);
  });

  it('names a mounted route with no contract', () => {
    const report = compareRegistries({
      registered: ['GET /api/health', 'POST /api/ops/meta'],
      registries: registries(),
    });

    expect(report.undeclared).toEqual(['POST /api/ops/meta']);
  });

  it('names a key that appears in both registries', () => {
    // 展开成并集时后者会静默覆盖前者，路由仍然「有条目」，只是校验的是另一份 schema。
    const report = compareRegistries({
      registered: ['GET /api/health'],
      registries: registries({ OPS_ROUTES: { health: route('GET', '/api/v1/ops/health') } }),
    });

    expect(report.duplicateKeys).toEqual(['health: ROUTES + OPS_ROUTES']);
    // 两张表的路径不同，所以 ops 那条算「清单有、路由没挂」。
    expect(report.unmounted).toEqual(['GET /api/v1/ops/health']);
  });

  it('names an ops route under the wrong prefix', () => {
    const report = compareRegistries({
      registered: ['GET /api/health', 'GET /api/ops/meta'],
      registries: registries({
        OPS_ROUTES: { getOpsMeta: route('GET', '/api/ops/meta') },
      }),
      requiredPrefix: { OPS_ROUTES: '/api/v1/ops' },
    });

    expect(report.misplaced).toEqual([
      {
        key: 'getOpsMeta',
        registry: 'OPS_ROUTES',
        path: '/api/ops/meta',
        expectedPrefix: '/api/v1/ops',
      },
    ]);
  });

  it('does not apply a prefix rule to registries that have none', () => {
    const report = compareRegistries({
      registered: ['GET /api/health'],
      registries: registries(),
      requiredPrefix: { OPS_ROUTES: '/api/v1/ops' },
    });

    expect(report.misplaced).toEqual([]);
  });
});
