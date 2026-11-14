import type { RouteRecordRaw } from 'vue-router';

import { createMemoryHistory, createRouter } from 'vue-router';

import { describe, expect, it, vi } from 'vitest';

import { generateAccess, resetAccessRoutes } from '../access';
import { fallbackNotFoundRoute } from '../routes/core';
import { cloneRoutes, domainRoutes } from './test-utils';

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend' } },
}));

vi.mock('#/layouts', () => ({
  BasicLayout: { name: 'BasicLayout', render: () => null },
  IFrameView: { name: 'IFrameView', render: () => null },
}));

const WHITE_LIST: RouteRecordRaw[] = [
  { name: 'Root', path: '/', children: [] },
  fallbackNotFoundRoute,
];

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        children: [],
        component: { name: 'RootShell', render: () => null },
        name: 'Root',
        path: '/',
      },
      fallbackNotFoundRoute,
    ],
  });
}

describe('登录后生成路由 / 登出后清理路由', () => {
  it('按 accessCodes 生成路由，未授权域不注册', async () => {
    const router = createTestRouter();

    await generateAccess({
      accessCodes: ['customer.read'],
      router,
      routes: cloneRoutes(domainRoutes),
    });

    expect(router.hasRoute('Customer')).toBe(true);
    expect(router.hasRoute('CustomerList')).toBe(true);
    expect(router.hasRoute('BillingReceivables')).toBe(false);
  });

  it('登出清理后动态路由全部移除，核心路由保留', async () => {
    const router = createTestRouter();

    await generateAccess({
      accessCodes: ['customer.read', 'ticket.read'],
      router,
      routes: cloneRoutes(domainRoutes),
    });
    expect(router.hasRoute('SupportTicketList')).toBe(true);

    // store 侧登出调用的就是 resetRoutes → resetAccessRoutes(router, routes)
    resetAccessRoutes(router, WHITE_LIST);

    expect(router.hasRoute('CustomerList')).toBe(false);
    expect(router.hasRoute('SupportTicketList')).toBe(false);
    expect(router.hasRoute('Root')).toBe(true);
    expect(router.hasRoute('FallbackNotFound')).toBe(true);
  });

  it('换账号后只保留新账号的路由（不残留上一个账号的菜单）', async () => {
    const router = createTestRouter();

    await generateAccess({
      accessCodes: ['customer.read'],
      router,
      routes: cloneRoutes(domainRoutes),
    });
    resetAccessRoutes(router, WHITE_LIST);

    await generateAccess({
      accessCodes: ['ticket.read'],
      router,
      routes: cloneRoutes(domainRoutes),
    });

    expect(router.hasRoute('SupportTicketList')).toBe(true);
    expect(router.hasRoute('CustomerList')).toBe(false);
  });
});
