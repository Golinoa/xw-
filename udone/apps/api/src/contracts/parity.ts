import type { RouteContract } from '@erp/contracts';

/**
 * 契约清单与真实路由的对账。
 *
 * 抽成纯函数不是为了好看：对账逻辑本身如果有洞，集成位置看不出区别——两者
 * 都是「跑一次、结果为空」。只有把「给一份错的数据，它必须报错」写成断言，
 * 才能证明这个门禁在 T-01 之后真的会拦住漏登记的路由。
 */

export type RouteRegistries = Record<string, Record<string, RouteContract>>;

export interface ParityInput {
  /** 真实挂载的路由，形如 `GET /api/health`。 */
  registered: readonly string[];
  /** 全部契约注册表，键名只用于报错时说明出处。 */
  registries: RouteRegistries;
  /** 每个注册表必须满足的路径前缀；未列出的注册表不检查。 */
  requiredPrefix?: Record<string, string>;
}

export interface ParityReport {
  /** 清单里有、路由没挂。 */
  unmounted: string[];
  /** 路由挂了、清单没登记。 */
  undeclared: string[];
  /** 同一个 key 出现在两张表里：展开成并集时会静默覆盖，只能在这里发现。 */
  duplicateKeys: string[];
  /** 路径前缀不对，例如 ops 的端点写成了 `/api/ops/meta`。 */
  misplaced: { key: string; registry: string; path: string; expectedPrefix: string }[];
}

function signature(route: RouteContract): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

export function compareRegistries(input: ParityInput): ParityReport {
  const mounted = new Set(input.registered);
  const declared = new Set<string>();
  const owners = new Map<string, string[]>();
  const report: ParityReport = {
    unmounted: [],
    undeclared: [],
    duplicateKeys: [],
    misplaced: [],
  };

  for (const [registryName, registry] of Object.entries(input.registries)) {
    for (const [key, route] of Object.entries(registry)) {
      declared.add(signature(route));
      const previous = owners.get(key) ?? [];
      previous.push(registryName);
      owners.set(key, previous);

      const prefix = input.requiredPrefix?.[registryName];
      if (prefix && !route.path.startsWith(prefix)) {
        report.misplaced.push({
          key,
          registry: registryName,
          path: route.path,
          expectedPrefix: prefix,
        });
      }
    }
  }

  for (const [key, registryNames] of owners) {
    if (registryNames.length > 1) {
      report.duplicateKeys.push(`${key}: ${registryNames.join(' + ')}`);
    }
  }

  report.unmounted = [...declared].filter((route) => !mounted.has(route)).sort();
  report.undeclared = input.registered.filter((route) => !declared.has(route)).sort();
  return report;
}
