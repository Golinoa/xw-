import type { AxiosResponse, InternalAxiosRequestConfig } from '@vben/request';
import type { useAccessStore } from '@vben/stores';

import { AxiosError, AxiosHeaders } from '@vben/request';

import { createPinia, setActivePinia } from 'pinia';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
  const authStore = {
    logout: vi.fn(async () => undefined),
    markSessionExpired: vi.fn(),
  };
  return { authStore };
});

// 只替换边界（store 出口），不 mock 网络细节
vi.mock('#/store', () => ({
  useAuthStore: () => mocks.authStore,
}));

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');
vi.stubEnv('VITE_NITRO_MOCK', 'false');

type AdapterHandler = (
  config: InternalAxiosRequestConfig,
) => AdapterResult | Promise<AdapterResult>;

interface AdapterResult {
  data?: unknown;
  headers?: Record<string, string>;
  status: number;
}

interface RequestModule {
  baseRequestClient: {
    instance: { defaults: { adapter?: unknown } };
  };
  requestClient: {
    get: (url: string, config?: Record<string, unknown>) => Promise<unknown>;
    instance: { defaults: { adapter?: unknown } };
    post: (
      url: string,
      data?: unknown,
      config?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
}

let requestModule: RequestModule;
let accessStore: ReturnType<typeof useAccessStore>;
let notices: string[];

/**
 * 只有这一层是 mock：把 HTTP 适配器替换成内存实现。
 *
 * 必须自己复刻 `settle` 的语义（非 2xx → reject 带 response 的 AxiosError），
 * 否则 axios 会把 4xx/5xx 当成成功响应，测出来的就不是真实链路了。
 */
function adapterFrom(handler: AdapterHandler) {
  return async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const result = await handler(config);
    const response: AxiosResponse = {
      config,
      data: result.data,
      headers: result.headers ?? {},
      status: result.status,
      statusText: String(result.status),
    };
    if (result.status >= 200 && result.status < 300) {
      return response;
    }
    throw new AxiosError(
      `Request failed with status code ${result.status}`,
      result.status >= 500
        ? AxiosError.ERR_BAD_RESPONSE
        : AxiosError.ERR_BAD_REQUEST,
      config,
      null,
      response,
    );
  };
}

function headerOf(config: InternalAxiosRequestConfig, name: string) {
  const headers = config.headers as AxiosHeaders;
  return headers.get(name)?.toString() ?? '';
}

beforeAll(async () => {
  const { setOpsErrorNotifier } = await import('../adapter/notify');
  setOpsErrorNotifier((error) => {
    notices.push(error.userMessage);
  });
  requestModule = (await import('../request')) as unknown as RequestModule;
});

beforeEach(async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const { useAccessStore } = await import('@vben/stores');
  accessStore = useAccessStore();
  accessStore.setAccessToken(null);
  accessStore.isAccessChecked = true;
  notices = [];
  mocks.authStore.logout.mockClear();
  mocks.authStore.markSessionExpired.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('请求头', () => {
  it('每次请求注入 X-Request-Id（UUID v4），且不写 Bearer null', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(
      (config) => {
        seen.push(config);
        return { data: { ok: true }, status: 200 };
      },
    );

    await requestModule.requestClient.get('/v1/ops/session');
    await requestModule.requestClient.get('/v1/ops/session');

    expect(seen).toHaveLength(2);
    const requestIds = seen.map((config) => headerOf(config, 'X-Request-Id'));
    const authorizationHeaders = seen.map((config) =>
      headerOf(config, 'Authorization'),
    );

    expect(requestIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(requestIds[1]).not.toBe(requestIds[0]);
    expect(authorizationHeaders).toEqual(['', '']);
  });

  it('有 token 时写入 Bearer 头', async () => {
    accessStore.setAccessToken('access-token-1');
    let authorization = '';
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(
      (config) => {
        authorization = headerOf(config, 'Authorization');
        return { data: {}, status: 200 };
      },
    );

    await requestModule.requestClient.get('/v1/ops/session');
    expect(authorization).toBe('Bearer access-token-1');
  });
});

describe('错误映射', () => {
  it('4xx 不重试，并映射为可读文案', async () => {
    const handler = vi.fn(() => ({
      data: {
        code: 'VALIDATION_ERROR',
        message: 'invalid',
        requestId: 'req-400',
      },
      status: 400,
    }));
    requestModule.requestClient.instance.defaults.adapter =
      adapterFrom(handler);

    const error = await requestModule.requestClient
      .get('/v1/ops/customers')
      .catch((error_: unknown) => error_);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      requestId: 'req-400',
      status: 400,
      userMessage: '提交内容有误，请检查标记的字段',
    });
    expect(notices).toEqual(['提交内容有误，请检查标记的字段']);
  });

  it('403 按 details.reason 区分无权限 / 非运营成员 / 停用', async () => {
    const cases = [
      {
        details: { reason: 'OPS_MEMBER_MISSING' },
        expected: '当前账号不是运营成员，请联系管理员开通用权',
      },
      {
        details: { reason: 'OPS_MEMBER_INACTIVE' },
        expected: '运营账号已停用或尚未激活，请联系管理员',
      },
      { details: {}, expected: '你没有执行此操作的权限' },
    ];

    for (const item of cases) {
      requestModule.requestClient.instance.defaults.adapter = adapterFrom(
        () => ({
          data: {
            code: 'FORBIDDEN',
            details: item.details,
            message: 'forbidden',
          },
          status: 403,
        }),
      );
      const error = await requestModule.requestClient
        .get('/v1/ops/session')
        .catch((error_: unknown) => error_);
      expect(error).toMatchObject({ status: 403, userMessage: item.expected });
    }
  });

  it('409 冲突提示刷新后重试', async () => {
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(() => ({
      data: { code: 'CONFLICT', message: 'version mismatch' },
      status: 409,
    }));
    const error = await requestModule.requestClient
      .get('/v1/ops/customers/1')
      .catch((error_: unknown) => error_);
    expect(error).toMatchObject({
      status: 409,
      userMessage: '数据已变更，请刷新后重试',
    });
  });

  it('5xx 最多重试 3 次（共 4 次请求）后失败', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(() => ({
      data: { code: 'INTERNAL_ERROR', message: 'boom' },
      status: 503,
    }));
    requestModule.requestClient.instance.defaults.adapter =
      adapterFrom(handler);

    const pending = requestModule.requestClient
      .get('/v1/ops/customers')
      .catch((error_: unknown) => error_);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await pending;

    expect(handler).toHaveBeenCalledTimes(4);
    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 503,
      userMessage: '服务暂时不可用，请稍后重试',
    });
  });

  it('5xx 重试后成功则返回业务体', async () => {
    vi.useFakeTimers();
    let call = 0;
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(() => {
      call += 1;
      if (call === 1) {
        return { data: { code: 'INTERNAL_ERROR' }, status: 500 };
      }
      return { data: { contractVersion: '1.0.0' }, status: 200 };
    });

    const pending = requestModule.requestClient.get('/v1/ops/meta');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ contractVersion: '1.0.0' });
    expect(call).toBe(2);
  });

  it('网络错误归类为 network 并重试到上限', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(
      (config) => {
        attempts += 1;
        throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
      },
    );

    const pending = requestModule.requestClient
      .get('/v1/ops/meta')
      .catch((error_: unknown) => error_);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await pending;

    expect(attempts).toBe(4);
    expect(error).toMatchObject({
      code: 'NETWORK_ERROR',
      kind: 'network',
      userMessage: '网络连接失败，请检查网络后重试',
    });
  });
});

describe('401 刷新与重放', () => {
  it('401 → 刷新 → 用新 token 重放一次，且保持同一 requestId', async () => {
    accessStore.setAccessToken('expired-token');
    const requestIds: string[] = [];
    let authorization = '';

    requestModule.requestClient.instance.defaults.adapter = adapterFrom(
      (config) => {
        requestIds.push(headerOf(config, 'X-Request-Id'));
        authorization = headerOf(config, 'Authorization');
        if (requestIds.length === 1) {
          return { data: { code: 'AUTH_REQUIRED' }, status: 401 };
        }
        return { data: { operator: { id: 'op-1' } }, status: 200 };
      },
    );

    const refreshHandler = vi.fn(() => ({
      data: { accessToken: 'fresh-token' },
      status: 200,
    }));
    requestModule.baseRequestClient.instance.defaults.adapter =
      adapterFrom(refreshHandler);

    const result = await requestModule.requestClient.get('/v1/ops/session');

    expect(result).toEqual({ operator: { id: 'op-1' } });
    expect(refreshHandler).toHaveBeenCalledTimes(1);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(authorization).toBe('Bearer fresh-token');
    expect(accessStore.accessToken).toBe('fresh-token');
    expect(mocks.authStore.logout).not.toHaveBeenCalled();
  });

  it('刷新返回 401 时清理会话并提示重登', async () => {
    accessStore.setAccessToken('expired-token');
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(() => ({
      data: { code: 'AUTH_REQUIRED' },
      status: 401,
    }));
    requestModule.baseRequestClient.instance.defaults.adapter = adapterFrom(
      () => ({ data: { code: 'AUTH_REQUIRED' }, status: 401 }),
    );

    const error = await requestModule.requestClient
      .get('/v1/ops/session')
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ code: 'AUTH_REQUIRED', status: 401 });
    expect(accessStore.accessToken).toBeNull();
    expect(mocks.authStore.markSessionExpired).toHaveBeenCalledTimes(1);
    expect(mocks.authStore.logout).toHaveBeenCalledTimes(1);
  });

  it('刷新遇到网络错误不登出（可重试错误态）', async () => {
    accessStore.setAccessToken('expired-token');
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(() => ({
      data: { code: 'AUTH_REQUIRED' },
      status: 401,
    }));
    requestModule.baseRequestClient.instance.defaults.adapter = adapterFrom(
      (config) => {
        throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
      },
    );

    await requestModule.requestClient
      .get('/v1/ops/session')
      .catch((error: unknown) => error);

    expect(mocks.authStore.logout).not.toHaveBeenCalled();
    expect(mocks.authStore.markSessionExpired).not.toHaveBeenCalled();
  });

  it('并发 401 只触发一次刷新', async () => {
    accessStore.setAccessToken('expired-token');
    let calls = 0;
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(
      (config) => {
        calls += 1;
        if (headerOf(config, 'Authorization') === 'Bearer expired-token') {
          return { data: { code: 'AUTH_REQUIRED' }, status: 401 };
        }
        return { data: { calls }, status: 200 };
      },
    );
    const refreshHandler = vi.fn(async () => ({
      data: { accessToken: 'fresh-token' },
      status: 200,
    }));
    requestModule.baseRequestClient.instance.defaults.adapter =
      adapterFrom(refreshHandler);

    await Promise.all([
      requestModule.requestClient.get('/v1/ops/session'),
      requestModule.requestClient.get('/v1/ops/meta'),
    ]);

    expect(refreshHandler).toHaveBeenCalledTimes(1);
  });

  it('登录端点的 401 是凭据错误：不刷新、不弹全局提示（由登录页内联）', async () => {
    const { loginApi } = await import('../core/auth');
    requestModule.requestClient.instance.defaults.adapter = adapterFrom(() => ({
      data: { code: 'AUTH_REQUIRED' },
      status: 401,
    }));
    const refreshHandler = vi.fn();
    requestModule.baseRequestClient.instance.defaults.adapter =
      adapterFrom(refreshHandler);

    const error = await loginApi({ password: 'bad', username: 'stub' }).catch(
      (error_: unknown) => error_,
    );

    expect(error).toMatchObject({
      status: 401,
      userMessage: '账号或密码不正确，请重新输入',
    });
    expect(refreshHandler).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });
});
