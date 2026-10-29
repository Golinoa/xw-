/**
 * 契约响应回放（HTTP 层）。
 *
 * 用途：`chromium-http-contract` 项目里 dev server 以 `VITE_OPS_MOCK=false` 启动，
 * axios 走真实 HTTP 路径（`/api/v1/ops/*`），由本文件按 `Docs/ops-api-contract.md`
 * 的形状回放响应。这样可以在同一个应用上验证「权限子集」场景——应用内契约桩
 * 固定授予全部动作码，做不到这一点（见 journal 缺口记录）。
 *
 * 边界：这是**契约回放**，不是真实后端集成；不校验鉴权、RLS、幂等与事务。
 */
import type { Page } from '@playwright/test';

export interface OpsSessionPayload {
  lastLoginAt: null | string;
  operator: {
    displayName: string;
    email: string;
    id: string;
    mfaRequired: boolean;
    status: 'active' | 'disabled' | 'invited';
  };
  permissionVersion: number;
  permissions: string[];
  roles: { code: string; name: string }[];
}

/** 构造一个只授予给定动作码的会话（虚构运营成员）。 */
export function sessionWithPermissions(
  permissions: string[],
): OpsSessionPayload {
  return {
    lastLoginAt: '2026-10-29T02:00:00Z',
    operator: {
      displayName: '契约回放·受限运营（虚构）',
      email: 'ops.restricted@example.invalid',
      id: '00000000-0000-4000-8000-0000000000e2',
      mfaRequired: false,
      status: 'active',
    },
    permissionVersion: 1,
    permissions,
    roles: [{ code: 'ops_e2e_restricted', name: 'e2e 受限角色（虚构）' }],
  };
}

const API_PREFIX = '/api/v1/ops/';

/**
 * 安装运营 API 的契约回放。
 *
 * 未列出的运营端点统一返回 404，避免请求穿透到本地不存在的 5320 代理目标后
 * 变成不可诊断的超时。
 */
export async function installOpsContract(
  page: Page,
  options: { permissions: string[] },
): Promise<void> {
  const session = sessionWithPermissions(options.permissions);

  await page.route(/\/api\/v1\/ops\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const endpoint = pathname.slice(
      pathname.indexOf(API_PREFIX) + API_PREFIX.length,
    );
    const method = request.method();

    if (endpoint === 'auth/login' && method === 'POST') {
      await route.fulfill({
        body: JSON.stringify({ accessToken: 'e2e-contract-token' }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (endpoint === 'session' && method === 'GET') {
      await route.fulfill({
        body: JSON.stringify(session),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (endpoint === 'auth/logout' && method === 'POST') {
      await route.fulfill({ status: 204 });
      return;
    }

    if (endpoint === 'meta' && method === 'GET') {
      await route.fulfill({
        body: JSON.stringify({
          contractVersion: '1.0.0-e2e',
          serverTime: '2026-10-29T02:00:00Z',
          supportedCurrencies: ['CNY'],
          supportedSalesModes: ['saas', 'private'],
          timezone: 'Asia/Shanghai',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (endpoint === 'permissions' && method === 'GET') {
      await route.fulfill({
        body: JSON.stringify({
          items: session.permissions.map((code) => ({
            code,
            description: 'e2e 契约回放条目（虚构）',
            domain: code.split('.')[0] ?? 'unknown',
            isHighRisk: false,
          })),
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    await route.fulfill({
      body: JSON.stringify({
        code: 'NOT_FOUND',
        message: 'e2e 契约未定义该端点',
      }),
      contentType: 'application/json',
      status: 404,
    });
  });
}

/**
 * 会话内跳转（等价于在地址栏输入 URL，但保留内存中的 access token）。
 *
 * access token 只驻内存（设计文档 §2.1.8），完整页面加载必然丢会话，
 * 因此「直接输入受保护 URL」用 history + popstate 触发 vue-router 的同类导航。
 */
export async function gotoInSession(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
