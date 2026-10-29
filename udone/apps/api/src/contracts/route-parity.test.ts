import { describe, expect, it } from 'vitest';
import { ROUTES } from '@erp/contracts';
import { app } from '../index';

/**
 * 契约清单 ↔ 真实路由对账。
 *
 * 只在 `ROUTES` 里写了契约、却忘了在 Hono 上挂路由（或反过来），都会在这里失败。
 * 这是「文档写了但代码没做」最容易被漏掉的一环。
 */
const RESERVED_METHODS = new Set(['ALL', 'USE']);

function registeredRoutes() {
  return app.routes
    .filter((route) => !RESERVED_METHODS.has(route.method))
    .map((route) => `${route.method.toUpperCase()} ${route.path}`);
}

describe('route registry parity', () => {
  it('registers every route declared in the shared contract', () => {
    const registered = new Set(registeredRoutes());
    const missing = Object.entries(ROUTES)
      .filter(([, route]) => !registered.has(`${route.method} ${route.path}`))
      .map(([key, route]) => `${key}: ${route.method} ${route.path}`);

    expect(missing).toEqual([]);
  });

  it('declares a contract for every registered route', () => {
    const declared = new Set(Object.values(ROUTES).map((route) => `${route.method} ${route.path}`));
    const undeclared = registeredRoutes().filter((route) => !declared.has(route));

    expect(undeclared).toEqual([]);
  });
});
