/**
 * 开发态契约桩入口。
 *
 * 启用条件：`VITE_OPS_MOCK=true`（默认 false）。
 * 只在开发态生效：调用点用 `import.meta.env.VITE_OPS_MOCK === 'true'` 这种**字面量比较**，
 * 生产构建下分支恒为 false，Vite/esbuild 会把整个目录连同动态 import 一起摇掉。
 *
 * 这里只实现 identity 域的会话端点：其它域尚未实现（见 `src/api/ops/README.md`），
 * 不预先编造未定字段。
 */
import type {
  OpsLoginResult,
  OpsMeta,
  OpsPermissionCatalog,
  OpsSession,
} from '../identity/session';

import { OpsApiError } from '#/api/adapter/errors';

import { mountStubBanner } from './banner';
import {
  STUB_CREDENTIALS,
  STUB_META,
  STUB_PERMISSION_CATALOG,
  STUB_SESSION,
} from './fixtures';

const STUB_LATENCY_MS = 80;

function respond<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), STUB_LATENCY_MS);
  });
}

function cloneSession(): OpsSession {
  return {
    ...STUB_SESSION,
    operator: { ...STUB_SESSION.operator },
    permissions: [...STUB_SESSION.permissions],
    roles: STUB_SESSION.roles.map((role) => ({ ...role })),
  };
}

export async function stubOpsLogin(params: {
  password?: string;
  username?: string;
}): Promise<OpsLoginResult> {
  mountStubBanner();
  const { password, username } = params;
  if (
    username !== STUB_CREDENTIALS.username ||
    password !== STUB_CREDENTIALS.password
  ) {
    throw new OpsApiError({
      code: 'AUTH_REQUIRED',
      kind: 'http',
      retryable: false,
      status: 401,
      userMessage: '账号或密码不正确（开发桩账号：stub / stub）',
    });
  }
  return respond({ accessToken: 'stub-access-token' });
}

export async function stubOpsRefresh(): Promise<OpsLoginResult> {
  mountStubBanner();
  return respond({ accessToken: 'stub-access-token' });
}

export async function stubOpsLogout(): Promise<void> {
  mountStubBanner();
  await respond(undefined);
}

export async function stubOpsSession(): Promise<OpsSession> {
  mountStubBanner();
  return respond(cloneSession());
}

export async function stubOpsMeta(): Promise<OpsMeta> {
  mountStubBanner();
  return respond({ ...STUB_META });
}

export async function stubOpsPermissions(): Promise<OpsPermissionCatalog> {
  mountStubBanner();
  return respond({
    items: STUB_PERMISSION_CATALOG.items.map((item) => ({ ...item })),
  });
}
