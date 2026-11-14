import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 开发态契约桩（`VITE_OPS_MOCK=true`）的行为契约。
 *
 * 关于模块加载顺序：`env.ts` 在模块求值时读取并校验 `import.meta.env`，
 * 因此必须在 `beforeAll` 里做**一次**动态导入，而不能用静态 import
 * （静态 import 会被提升到文件顶部的 `vi.stubEnv` 之前）。
 *
 * 这里刻意**不再**调用 `vi.resetModules()`：桩的开关判断已全部改为
 * 调用点内联读取 `import.meta.env.VITE_OPS_MOCK`，运行时改环境变量即生效，
 * 无需重建模块图。此前每个用例重置模块会让整个依赖图反复重解释，
 * 实测会导致 fork worker 启动超时（"Timeout waiting for worker to respond"），
 * 表现为「所有用例通过但进程非零退出」的假失败。
 */
vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'true');
vi.stubEnv('VITE_NITRO_MOCK', 'false');

describe('开发态契约桩（VITE_OPS_MOCK=true）', () => {
  let loginApi: typeof import('../core/auth').loginApi;
  let fetchOpsSession: typeof import('../ops/identity/session').fetchOpsSession;
  let permissionCodes: string[];

  beforeAll(async () => {
    ({ loginApi } = await import('../core/auth'));
    ({ fetchOpsSession } = await import('../ops/identity/session'));
    const constants = await import('#/constants/permissions');
    permissionCodes = [...constants.OPS_PERMISSION_CODES];
  });

  it('登录只接受桩账号，其它口令返回 401 凭据错误', async () => {
    const error = await loginApi({
      password: 'whatever',
      username: 'admin',
    }).catch((error_: unknown) => error_);
    expect(error).toMatchObject({ code: 'AUTH_REQUIRED', status: 401 });

    await expect(
      loginApi({ password: 'stub', username: 'stub' }),
    ).resolves.toEqual({ accessToken: 'stub-access-token' });
  });

  it('会话返回虚构数据，且权限码来自冻结的权限目录', async () => {
    const session = await fetchOpsSession();

    expect(session.operator.email).toMatch(/@example\.invalid$/);
    expect(session.operator.displayName).toContain('虚构');
    expect(session.permissions).toEqual(permissionCodes);
  });

  it('桩在界面上可见提示（挂载顶部条幅）', async () => {
    await fetchOpsSession();

    const banner = document.querySelector('#ops-dev-stub-banner');
    expect(banner?.textContent).toContain('开发态契约桩');
  });
});
