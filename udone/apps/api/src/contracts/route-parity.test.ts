import { describe, expect, it } from 'vitest';
import { ROUTE_REGISTRIES } from '@erp/contracts';
import { app } from '../index';
import { compareRegistries, type RouteRegistries } from './parity';

/**
 * 契约清单 ↔ 真实路由对账。
 *
 * 只在注册表里写了契约、却忘了在 Hono 上挂路由（或反过来），都会在这里失败。
 * 这是「文档写了但代码没做」最容易被漏掉的一环。
 *
 * 两张表都覆盖：`ROUTES`（租户业务端，`/api/*`）与 `OPS_ROUTES`（运营后台，
 * `/api/v1/ops/*`）。第二张现在是空的，所以这些断言今天等价于只查第一张——
 * 但 T-01 往里登记第一条时，它们会自动生效，不需要再改这个文件。
 */
const RESERVED_METHODS = new Set(['ALL', 'USE']);

function registeredRoutes() {
  return app.routes
    .filter((route) => !RESERVED_METHODS.has(route.method))
    .map((route) => `${route.method.toUpperCase()} ${route.path}`);
}

describe('route registry parity', () => {
  it('keeps every registry entry mounted and every mounted route declared', () => {
    const report = compareRegistries({
      registered: registeredRoutes(),
      registries: ROUTE_REGISTRIES as unknown as RouteRegistries,
      requiredPrefix: { OPS_ROUTES: '/api/v1/ops' },
    });

    expect(report.unmounted).toEqual([]);
    expect(report.undeclared).toEqual([]);
    expect(report.duplicateKeys).toEqual([]);
    expect(report.misplaced).toEqual([]);
  });

  it('covers the ops registry, not just the business one', () => {
    // 断言遍历的是并集：漏掉任何一张表都会让 T-01 之后的新端点失去保护。
    expect(Object.keys(ROUTE_REGISTRIES)).toEqual(['ROUTES', 'OPS_ROUTES']);
  });
});
