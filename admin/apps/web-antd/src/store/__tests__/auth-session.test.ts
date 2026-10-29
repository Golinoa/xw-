import type { AxiosResponse, InternalAxiosRequestConfig } from '@vben/request';

import { createApp } from 'vue';

import { AxiosError, AxiosHeaders } from '@vben/request';

import { createPinia, setActivePinia } from 'pinia';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPS_PERMISSION } from '#/constants/permissions';

const mocks = vi.hoisted(() => ({
  router: {
    currentRoute: { value: { fullPath: '/contracts' } },
    push: vi.fn(async () => undefined),
    replace: vi.fn(async () => undefined),
  },
  resetRoutes: vi.fn(),
  notification: { error: vi.fn(), success: vi.fn() },
}));

// 边界 mock：路由实例、动态路由重置、全局提示、i18n
vi.mock('vue-router', () => ({ useRouter: () => mocks.router }));
vi.mock('#/router', () => ({ resetRoutes: mocks.resetRoutes }));
vi.mock('ant-design-vue', () => ({ notification: mocks.notification }));
vi.mock('#/locales', () => ({ $t: (key: string) => key }));

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');
vi.stubEnv('VITE_NITRO_MOCK', 'false');

type Responder = (
  config: InternalAxiosRequestConfig,
) =>
  | Promise<{ data?: unknown; status: number }>
  | { data?: unknown; status: number };

interface Harness {
  authStore: ReturnType<(typeof import('#/store'))['useAuthStore']>;
  accessStore: {
    accessCodes: string[];
    accessToken: null | string;
    loginExpired: boolean;
  };
  installApi: (responder: Responder) => void;
  setMeta: (responder: Responder) => void;
  userStore: { userInfo: null | Record<string, unknown> };
}

let harness: Harness;

const SESSION = {
  lastLoginAt: '2026-10-29T02:00:00Z',
  operator: {
    displayName: '张运营（虚构）',
    email: 'ops.demo@example.invalid',
    id: 'op-1',
    mfaRequired: false,
    status: 'active',
  },
  permissionVersion: 7,
  permissions: [
    OPS_PERMISSION.OVERVIEW_READ,
    OPS_PERMISSION.CONTRACT_READ,
    'ops.not_registered.code',
  ],
  roles: [{ code: 'ops_admin', name: '运营管理员（虚构）' }],
};

/**
 * `/meta` 的默认响应（兼容当前前端锁定的契约版本）。
 *
 * 登录成功后会额外请求一次 `/meta` 做契约版本门，若不在这里统一应答，
 * 各用例的 responder fallback 会把 `/meta` 当成 `/session` 返回，
 * 导致 `contractVersion` 缺失、被判定 MALFORMED 而全部失败。
 * 需要验证不兼容路径的用例用 `harness.setMeta(...)` 覆盖。
 */
const META = {
  contractVersion: '1.0.0',
  serverTime: '2026-10-29T02:00:00Z',
  supportedCurrencies: ['CNY'],
  supportedSalesModes: ['one_time', 'perpetual', 'subscription'],
  timezone: 'Asia/Shanghai',
};

beforeAll(async () => {
  const app = createApp({});
  const { initStores } = await import('@vben/stores');
  await initStores(app, { namespace: 'unit-test' });

  const { setOpsErrorNotifier } = await import('#/api/adapter/notify');
  setOpsErrorNotifier(() => undefined);
});

beforeEach(async () => {
  setActivePinia(createPinia());
  const { useAuthStore } = await import('#/store');
  const { useAccessStore, useUserStore } = await import('@vben/stores');
  const { requestClient, baseRequestClient } = await import('#/api/request');

  const accessStore = useAccessStore();
  accessStore.setAccessToken(null);
  accessStore.setAccessCodes([]);
  accessStore.setLoginExpired(false);
  const userStore = useUserStore();
  userStore.setUserInfo(null);

  mocks.router.push.mockClear();
  mocks.router.replace.mockClear();
  mocks.resetRoutes.mockClear();
  mocks.notification.success.mockClear();

  // 每个用例重置：默认返回兼容版本，覆盖后仅对本用例生效
  let metaResponder: Responder = () => ({ data: META, status: 200 });

  const installApi = (responder: Responder) => {
    const adapter = async (config: InternalAxiosRequestConfig) => {
      // `/meta` 走独立应答：它是契约版本门，不属于用例要验证的业务请求。
      // 用例若要模拟后端版本不符，用 harness.setMeta 覆盖，不污染 responder。
      const result = config.url?.endsWith('/meta')
        ? await metaResponder(config)
        : await responder(config);
      const response: AxiosResponse = {
        config,
        data: result.data,
        headers: {},
        status: result.status,
        statusText: String(result.status),
      };
      if (result.status >= 200 && result.status < 300) {
        return response;
      }
      throw new AxiosError(
        'Request failed',
        AxiosError.ERR_BAD_REQUEST,
        config,
        null,
        response,
      );
    };
    requestClient.instance.defaults.adapter = adapter;
    baseRequestClient.instance.defaults.adapter = adapter;
  };

  harness = {
    accessStore,
    authStore: useAuthStore(),
    installApi,
    // 覆盖 `/meta` 应答，用于验证契约版本门
    setMeta: (responder: Responder) => {
      metaResponder = responder;
    },
    userStore,
  };
});

function headerOf(config: InternalAxiosRequestConfig, name: string) {
  return (config.headers as AxiosHeaders).get(name)?.toString() ?? '';
}

describe('登录状态机', () => {
  it('登录成功后写入 token、权限码与用户信息', async () => {
    harness.installApi((config) => {
      if (config.url?.endsWith('/auth/login')) {
        return { data: { accessToken: 'token-1' }, status: 200 };
      }
      return { data: SESSION, status: 200 };
    });

    const { userInfo } = await harness.authStore.authLogin({
      password: 'secret',
      username: 'ops.demo@example.invalid',
    });

    expect(userInfo.accessCodes).toEqual([
      OPS_PERMISSION.OVERVIEW_READ,
      OPS_PERMISSION.CONTRACT_READ,
    ]);
    expect(harness.authStore.sessionState).toBe('authenticated');
    expect(harness.accessStore.accessToken).toBe('token-1');
    // 未知动作码被过滤，已知动作码原样透传
    expect(harness.accessStore.accessCodes).toEqual([
      OPS_PERMISSION.OVERVIEW_READ,
      OPS_PERMISSION.CONTRACT_READ,
    ]);
    expect(harness.userStore.userInfo?.realName).toBe('张运营（虚构）');
    expect(harness.userStore.userInfo?.accessCodes).toEqual([
      OPS_PERMISSION.OVERVIEW_READ,
      OPS_PERMISSION.CONTRACT_READ,
    ]);
    expect(harness.userStore.userInfo?.roles).toEqual(['ops_admin']);
    expect(mocks.router.push).toHaveBeenCalledTimes(1);
  });

  it('契约 MAJOR 不兼容 → contract_mismatch，且不进业务页', async () => {
    harness.installApi((config) => {
      if (config.url?.endsWith('/auth/login')) {
        return { data: { accessToken: 'token-1' }, status: 200 };
      }
      return { data: SESSION, status: 200 };
    });
    harness.setMeta(() => ({
      data: { ...META, contractVersion: '2.0.0' },
      status: 200,
    }));

    const error = await harness.authStore
      .authLogin({ password: 'secret', username: 'ops.demo@example.invalid' })
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ code: 'CONTRACT_VERSION_MISMATCH' });
    expect(harness.authStore.sessionState).toBe('contract_mismatch');
    // 不进业务页是这条门禁的全部意义
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('契约 MINOR/PATCH 不同 → 正常登录（加法演进不阻断）', async () => {
    harness.installApi((config) => {
      if (config.url?.endsWith('/auth/login')) {
        return { data: { accessToken: 'token-1' }, status: 200 };
      }
      return { data: SESSION, status: 200 };
    });
    harness.setMeta(() => ({
      data: { ...META, contractVersion: '1.7.3' },
      status: 200,
    }));

    await harness.authStore.authLogin({
      password: 'secret',
      username: 'ops.demo@example.invalid',
    });

    expect(harness.authStore.sessionState).toBe('authenticated');
    expect(mocks.router.push).toHaveBeenCalledTimes(1);
  });

  it('凭据错误抛 OpsApiError，落到 failed 且不留 token', async () => {
    harness.installApi(() => ({
      data: { code: 'AUTH_REQUIRED', requestId: 'req-1' },
      status: 401,
    }));

    const error = await harness.authStore
      .authLogin({ password: 'wrong', username: 'ops.demo@example.invalid' })
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({
      status: 401,
      userMessage: '账号或密码不正确，请重新输入',
    });
    expect(harness.authStore.sessionState).toBe('failed');
    expect(harness.authStore.lastSessionError?.requestId).toBe('req-1');
    expect(harness.accessStore.accessToken).toBeNull();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('非运营成员 → no_membership，并清理半截会话', async () => {
    harness.installApi((config) => {
      if (config.url?.endsWith('/auth/login')) {
        return { data: { accessToken: 'token-1' }, status: 200 };
      }
      return {
        data: {
          code: 'FORBIDDEN',
          details: { reason: 'OPS_MEMBER_MISSING' },
          requestId: 'req-2',
        },
        status: 403,
      };
    });

    const error = await harness.authStore
      .authLogin({ password: 'secret', username: 'random@example.invalid' })
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ requestId: 'req-2', status: 403 });
    expect(harness.authStore.sessionState).toBe('no_membership');
    expect(harness.accessStore.accessToken).toBeNull();
    expect(harness.userStore.userInfo).toBeNull();
  });

  it('账号停用 → disabled', async () => {
    harness.installApi((config) => {
      if (config.url?.endsWith('/auth/login')) {
        return { data: { accessToken: 'token-1' }, status: 200 };
      }
      return {
        data: {
          code: 'FORBIDDEN',
          details: { reason: 'OPS_MEMBER_INACTIVE' },
        },
        status: 403,
      };
    });

    await harness.authStore
      .authLogin({ password: 's', username: 'u' })
      .catch(() => undefined);
    expect(harness.authStore.sessionState).toBe('disabled');
  });

  it('网络失败 → network_error，可重试且不跳转', async () => {
    harness.installApi((config) => {
      throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
    });

    const error = await harness.authStore
      .authLogin({ password: 's', username: 'u' })
      .catch((error_: unknown) => error_);

    expect(harness.authStore.sessionState).toBe('network_error');
    expect(error).toMatchObject({ kind: 'network' });
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('无任何动作码 → no_permission，清会话并抛可归类错误', async () => {
    harness.installApi((config) => {
      if (config.url?.endsWith('/auth/login')) {
        return { data: { accessToken: 'token-1' }, status: 200 };
      }
      return { data: { ...SESSION, permissions: [] }, status: 200 };
    });

    const error = await harness.authStore
      .authLogin({ password: 's', username: 'u' })
      .catch((error_: unknown) => error_);

    expect(harness.authStore.sessionState).toBe('no_permission');
    expect(error).toMatchObject({ code: 'FORBIDDEN' });
    expect(harness.accessStore.accessToken).toBeNull();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });
});

describe('登出与会话过期', () => {
  it('登出清理内存 token、权限码、用户信息，并重置动态路由', async () => {
    harness.installApi((config) => {
      if (config.url?.endsWith('/auth/login')) {
        return { data: { accessToken: 'token-1' }, status: 200 };
      }
      return { data: SESSION, status: 200 };
    });
    await harness.authStore.authLogin({ password: 's', username: 'u' });
    expect(harness.accessStore.accessToken).toBe('token-1');

    harness.installApi(() => ({ data: undefined, status: 204 }));
    await harness.authStore.logout();

    expect(harness.accessStore.accessToken).toBeNull();
    expect(harness.accessStore.accessCodes).toEqual([]);
    expect(harness.userStore.userInfo).toBeNull();
    expect(harness.authStore.sessionState).toBe('idle');
    expect(mocks.resetRoutes).toHaveBeenCalledTimes(1);
    expect(mocks.router.replace).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/auth/login' }),
    );
  });

  it('登出接口失败也要完成本地清理', async () => {
    harness.installApi(() => {
      throw new AxiosError('Network Error', AxiosError.ERR_NETWORK);
    });

    await harness.authStore.logout();

    expect(harness.accessStore.accessToken).toBeNull();
    expect(mocks.resetRoutes).toHaveBeenCalledTimes(1);
  });

  it('markSessionExpired 清 token 并进入 expired 态', async () => {
    harness.installApi((config) => {
      if (config.url?.endsWith('/auth/login')) {
        return { data: { accessToken: 'token-1' }, status: 200 };
      }
      return { data: SESSION, status: 200 };
    });
    await harness.authStore.authLogin({ password: 's', username: 'u' });

    harness.authStore.markSessionExpired();

    expect(harness.authStore.sessionState).toBe('expired');
    expect(harness.accessStore.accessToken).toBeNull();
    expect(harness.accessStore.accessCodes).toEqual([]);
    expect(harness.userStore.userInfo).toBeNull();
  });
});

describe('会话请求', () => {
  it('fetchUserInfo 携带 Bearer 头并回填权限码', async () => {
    const { useAccessStore } = await import('@vben/stores');
    useAccessStore().setAccessToken('token-9');

    let authorization = '';
    harness.installApi((config) => {
      authorization = headerOf(config, 'Authorization');
      return { data: SESSION, status: 200 };
    });

    const userInfo = await harness.authStore.fetchUserInfo();

    expect(authorization).toBe('Bearer token-9');
    expect(userInfo.permissionVersion).toBe(7);
    expect(useAccessStore().accessCodes).toEqual([
      OPS_PERMISSION.OVERVIEW_READ,
      OPS_PERMISSION.CONTRACT_READ,
    ]);
  });
});
