/**
 * 会话与权限目录（identity-audit 域）。
 *
 * 契约来源：`Docs/ops-api-contract.md` §5.1（meta / session / identity）。
 * 字段名严格照抄契约，不得自行改名；新增字段必须先在契约里出现。
 */
import { getOpsEnv } from '#/api/adapter/env';
import { requestClient } from '#/api/request';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

/**
 * 运营端点清单。全部端点都必须从这里取路径，禁止在调用处手写字符串，
 * 否则契约前缀调整（如 v2）时会漏改。
 */
export const OPS_ENDPOINTS = {
  /** 运营覆盖层登录 [推导：契约 §5.1 未列认证端点，路径沿用设计文档 §2.2] */
  login: `${OPS_API_PREFIX}/auth/login`,
  logout: `${OPS_API_PREFIX}/auth/logout`,
  refresh: `${OPS_API_PREFIX}/auth/refresh`,
  session: `${OPS_API_PREFIX}/session`,
  meta: `${OPS_API_PREFIX}/meta`,
  permissions: `${OPS_API_PREFIX}/permissions`,
} as const;

/** 运营成员状态。取值来自契约 §5.1 的 `status='invited'` 与 §6.4 的成员失效原因。 */
export type OpsOperatorStatus = 'active' | 'disabled' | 'invited';

export interface OpsOperator {
  id: string;
  displayName: string;
  email: string;
  status: OpsOperatorStatus;
  mfaRequired: boolean;
}

export interface OpsRole {
  code: string;
  name: string;
}

/** `GET /session` 响应。 */
export interface OpsSession {
  operator: OpsOperator;
  roles: OpsRole[];
  /** 权限动作码集合，真源为契约 §4。 */
  permissions: string[];
  permissionVersion: number;
  lastLoginAt: null | string;
}

/** `GET /meta` 响应。 */
export interface OpsMeta {
  contractVersion: string;
  serverTime: string;
  timezone: string;
  supportedSalesModes: string[];
  supportedCurrencies: string[];
}

/** `GET /permissions` 响应条目。 */
export interface OpsPermissionItem {
  code: string;
  domain: string;
  description: string;
  isHighRisk: boolean;
}

export interface OpsPermissionCatalog {
  items: OpsPermissionItem[];
}

/** `POST /auth/login` 响应 [推导：access token 只驻内存，刷新令牌走 Set-Cookie]。 */
export interface OpsLoginResult {
  accessToken: string;
}

/**
 * 当前运营会话。
 *
 * 该端点同时承担「是否运营成员」的判定：非运营成员或成员停用时后端返回
 * 403 `FORBIDDEN` + `details.reason`（`OPS_MEMBER_MISSING` / `OPS_MEMBER_INACTIVE`，
 * 契约 §5 通用约定），前端按 reason 落到不同会话状态。
 */
export async function fetchOpsSession(): Promise<OpsSession> {
  // 必须是静态字面量比较，VITE_OPS_MOCK=false 时该分支连同动态 import 一起被 tree-shake
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubOpsSession } = await import('../__stub__');
    return stubOpsSession();
  }
  return requestClient.get<OpsSession>(OPS_ENDPOINTS.session);
}

/** 契约自述端点：前端据 `contractVersion` 做不兼容快速失败（契约 §2.1）。 */
export async function fetchOpsMeta(): Promise<OpsMeta> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubOpsMeta } = await import('../__stub__');
    return stubOpsMeta();
  }
  return requestClient.get<OpsMeta>(OPS_ENDPOINTS.meta);
}

/** 权限动作目录（需 `operator.read`，用于角色配置页）。 */
export async function fetchOpsPermissions(): Promise<OpsPermissionCatalog> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubOpsPermissions } = await import('../__stub__');
    return stubOpsPermissions();
  }
  return requestClient.get<OpsPermissionCatalog>(OPS_ENDPOINTS.permissions);
}
