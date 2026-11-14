import type { RouteRecordRaw } from 'vue-router';

import { generateRoutesByFrontend } from '@vben/utils';

import { describe, expect, it, vi } from 'vitest';

import { OPS_PERMISSION_CODES } from '#/constants/permissions';

import {
  cloneRoutes,
  domainRoutes,
  leafRoutes,
  routePaths,
} from './test-utils';

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

const KNOWN_CODES = new Set<string>(OPS_PERMISSION_CODES);

async function visiblePaths(codes: string[]): Promise<string[]> {
  const result = await generateRoutesByFrontend(
    cloneRoutes(domainRoutes),
    codes,
  );
  return routePaths(result);
}

describe('路由动作码授权', () => {
  it('每个叶子路由都声明了动作码，且不出现角色名', () => {
    // /profile 是账号页，对任何已登录账号开放，不声明动作码
    const leaves = leafRoutes(domainRoutes).filter(
      (route) => route.path !== '/profile',
    );
    expect(leaves.length).toBeGreaterThan(0);

    for (const leaf of leaves) {
      const authority = leaf.meta?.authority;
      expect(
        Array.isArray(authority) && authority.length > 0,
        `${String(leaf.name)} 缺少 meta.authority`,
      ).toBe(true);

      for (const code of authority ?? []) {
        // 动作码命名规则：<领域>.<动作>，角色名（admin/finance）不含点
        expect(code).toContain('.');
        expect(
          KNOWN_CODES.has(code),
          `${String(leaf.name)} 使用了权限目录之外的码：${code}`,
        ).toBe(true);
      }
    }
  });

  it('有权限时对应路由可见', async () => {
    const paths = await visiblePaths(['customer.read']);

    expect(paths).toContain('/customers');
    expect(paths).toContain('/customers/list');
  });

  it('无权限时整棵子树不可见', async () => {
    const paths = await visiblePaths(['customer.read']);

    expect(paths).not.toContain('/billing');
    expect(paths).not.toContain('/billing/receivables');
    expect(paths).not.toContain('/overview');
  });

  it('单个动作码只放行其所属域（OR 语义，不串域）', async () => {
    const paths = await visiblePaths(['ticket.read']);

    expect(paths).toContain('/support/tickets');
    expect(paths).not.toContain('/contracts/list');
    expect(paths).not.toContain('/entitlements/licenses');
  });

  it('传角色名不会命中任何运营路由（证明呈现不依赖 roles）', async () => {
    const paths = await visiblePaths(['admin', 'finance', 'platform-admin']);

    for (const path of paths) {
      // 仅允许无 meta.authority 的路由（如 /profile）通过
      expect(['/profile']).toContain(path);
    }
  });

  it('全部动作码授予时 11 个一级模块全部可见', async () => {
    const result: RouteRecordRaw[] = await generateRoutesByFrontend(
      cloneRoutes(domainRoutes),
      [...OPS_PERMISSION_CODES],
    );

    // 账号页不参与域模块计数
    const topLevel = result
      .map((route) => route.path)
      .filter((path) => path !== '/profile');
    expect(topLevel).toHaveLength(11);
    expect(topLevel).toEqual(
      expect.arrayContaining([
        '/overview',
        '/customers',
        '/catalog',
        '/contracts',
        '/billing',
        '/entitlements',
        '/tenants',
        '/deployments',
        '/support',
        '/governance',
        '/audit',
      ]),
    );
  });
});
