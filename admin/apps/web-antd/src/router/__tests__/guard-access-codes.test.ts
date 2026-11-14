import { describe, expect, it, vi } from 'vitest';

import { resolveAccessCodes } from '../guard';

vi.mock('@vben/stores', () => ({
  useAccessStore: vi.fn(),
  useUserStore: vi.fn(),
}));

vi.mock('@vben/constants', () => ({
  LOGIN_PATH: '/auth/login',
}));

vi.mock('@vben/preferences', () => ({
  preferences: {
    app: { defaultHomePath: '/overview' },
    transition: { progress: false },
  },
}));

vi.mock('@vben/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vben/utils')>();
  return {
    ...actual,
    startProgress: vi.fn(),
    stopProgress: vi.fn(),
  };
});

vi.mock('#/store', () => ({
  useAuthStore: () => ({ fetchUserInfo: vi.fn() }),
}));

vi.mock('#/router/routes', () => ({
  accessRoutes: [],
  coreRouteNames: [],
}));

vi.mock('#/layouts', () => ({
  BasicLayout: { name: 'BasicLayout', render: () => null },
  IFrameView: { name: 'IFrameView', render: () => null },
}));

describe('守卫生成路由时使用的权限来源', () => {
  it('优先取 accessStore.accessCodes', () => {
    expect(
      resolveAccessCodes(['customer.read'], { roles: ['platform-admin'] }),
    ).toEqual(['customer.read']);
  });

  it('只有角色时视为无权限（roles 不参与路由生成）', () => {
    expect(resolveAccessCodes([], { roles: ['platform-admin'] })).toEqual([]);
    expect(resolveAccessCodes(undefined, { roles: ['admin'] })).toEqual([]);
  });

  it('store 为空时回退 userInfo.accessCodes，并过滤非法值', () => {
    expect(
      resolveAccessCodes(undefined, {
        accessCodes: ['contract.approve', 42, null, 'receipt.refund'],
        roles: ['finance'],
      }),
    ).toEqual(['contract.approve', 'receipt.refund']);
  });

  it('两处都没有时返回空数组', () => {
    expect(resolveAccessCodes([], null)).toEqual([]);
    expect(resolveAccessCodes(undefined, {})).toEqual([]);
  });
});
