import type { MenuRecordRaw } from '@vben/types';

import { createMemoryHistory, createRouter } from 'vue-router';

import { generateMenus, generateRoutesByFrontend } from '@vben/utils';

import { describe, expect, it, vi } from 'vitest';

import { OPS_PERMISSION_CODES } from '#/constants/permissions';

import { cloneRoutes, domainRoutes } from './test-utils';

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

async function buildMenus(codes: string[]): Promise<MenuRecordRaw[]> {
  const routes = await generateRoutesByFrontend(
    cloneRoutes(domainRoutes),
    codes,
  );
  const router = createRouter({ history: createMemoryHistory(), routes });
  return generateMenus(routes, router);
}

function menuPaths(menus: MenuRecordRaw[]): string[] {
  return menus.flatMap((menu) => [
    menu.path,
    ...(menu.children ? menuPaths(menu.children) : []),
  ]);
}

describe('菜单由 accessCodes 派生', () => {
  it('仅有客户读权限时，只出现客户域菜单', async () => {
    const menus = await buildMenus(['customer.read']);

    expect(menus.map((menu) => menu.path)).toEqual(['/customers']);
    expect(menuPaths(menus)).toContain('/customers/list');
    expect(menuPaths(menus).some((path) => path.startsWith('/billing'))).toBe(
      false,
    );
  });

  it('角色名不产生任何菜单（roles 不参与呈现）', async () => {
    expect(
      await buildMenus(['admin', 'finance', 'platform-admin']),
    ).toHaveLength(0);
  });

  it('权限为空时无业务菜单', async () => {
    expect(await buildMenus([])).toHaveLength(0);
  });

  it('全量动作码时一级菜单 11 项且按 order 排序', async () => {
    const menus = await buildMenus([...OPS_PERMISSION_CODES]);

    expect(menus.map((menu) => menu.path)).toEqual([
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
    ]);
  });

  it('隐藏菜单（hideInMenu）不进入菜单树', async () => {
    const menus = await buildMenus([...OPS_PERMISSION_CODES]);

    expect(menuPaths(menus)).not.toContain('/profile');
  });
});
