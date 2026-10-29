/**
 * 会话与权限目录（identity-audit 域）。
 *
 * 契约来源：`Docs/ops-api-contract.md` §5.1（meta / session / identity）。
 * 字段名严格照抄契约，不得自行改名；新增字段必须先在契约里出现。
 */
import { requestClient } from '#/api/request';

import { OPS_ENDPOINTS } from './endpoints';

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

/**
 * 契约自述端点。
 *
 * 兼容判定**不在这里**：本函数只负责取回 `/meta`，判定由
 * `contract-version.ts` 的 `checkContractCompatibility()` 完成，调用点在
 * `store/auth.ts` 登录成功之后（登录页不受阻断，否则看不到升级提示）。
 */
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
