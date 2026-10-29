import { createMemoryHistory, createRouter } from 'vue-router';

import { generateRoutesByFrontend } from '@vben/utils';

import { describe, expect, it, vi } from 'vitest';

import { coreRoutes, fallbackNotFoundRoute } from '#/router/routes/core';

import { cloneRoutes, domainRoutes } from './test-utils';

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

vi.mock('@vben/preferences', () => ({
  preferences: { app: { defaultHomePath: '/overview' } },
}));

async function createTestRouter(codes: string[]) {
  const authorized = await generateRoutesByFrontend(
    cloneRoutes(domainRoutes),
    codes,
  );

  return createRouter({
    history: createMemoryHistory(),
    routes: [...coreRoutes, ...authorized, fallbackNotFoundRoute],
  });
}

describe('未授权路由落 404', () => {
  it('直接输入无权限的 URL 命中兜底 404，而不是 403', async () => {
    const router = await createTestRouter(['ticket.read']);

    expect(router.resolve('/billing/receivables').name).toBe(
      'FallbackNotFound',
    );
    expect(router.hasRoute('BillingReceivables')).toBe(false);
  });

  it('有权限的 URL 正常解析到业务路由', async () => {
    const router = await createTestRouter(['ticket.read']);

    expect(router.resolve('/support/tickets').name).toBe('SupportTicketList');
  });

  it('完全无权限时所有业务 URL 都落 404', async () => {
    const router = await createTestRouter([]);

    for (const path of [
      '/overview',
      '/customers/list',
      '/contracts/list',
      '/audit/events',
    ]) {
      expect(router.resolve(path).name).toBe('FallbackNotFound');
    }
  });

  it('403 拒绝页可直接访问（ignoreAccess）', async () => {
    const router = await createTestRouter([]);

    expect(router.resolve('/error/403').name).toBe('Forbidden');
    expect(router.resolve('/error/403').meta.ignoreAccess).toBe(true);
  });
});
