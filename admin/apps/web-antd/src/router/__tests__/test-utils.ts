import type { RouteRecordRaw } from 'vue-router';

/**
 * 测试辅助：汇总全部运营域路由模块。
 *
 * `import.meta.glob` 与 `routes/index.ts` 使用同一模式，
 * 因此这里看到的路由树与生产构建一致（新增域文件自动纳入测试）。
 */
const modules = import.meta.glob<{ default: RouteRecordRaw[] }>(
  '../routes/modules/*.ts',
  { eager: true },
);

export const domainRoutes: RouteRecordRaw[] = Object.values(modules).flatMap(
  (module) => module.default,
);

/** 深拷贝路由树（保留 component 函数引用），避免过滤逻辑改写原始模块。 */
export function cloneRoutes(routes: RouteRecordRaw[]): RouteRecordRaw[] {
  return routes.map((route) => {
    const cloned = {
      ...route,
      meta: route.meta ? { ...route.meta } : undefined,
      children: route.children ? cloneRoutes(route.children) : undefined,
    };
    return cloned as RouteRecordRaw;
  });
}

/** 取所有叶子路由（没有 children 的节点）。 */
export function leafRoutes(routes: RouteRecordRaw[]): RouteRecordRaw[] {
  return routes.flatMap((route) =>
    route.children && route.children.length > 0
      ? leafRoutes(route.children)
      : [route],
  );
}

/** 取路由树中所有节点的 path。 */
export function routePaths(routes: RouteRecordRaw[]): string[] {
  return routes.flatMap((route) => [
    route.path,
    ...(route.children ? routePaths(route.children) : []),
  ]);
}
