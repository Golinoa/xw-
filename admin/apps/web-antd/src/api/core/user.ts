/**
 * 当前运营用户信息。
 *
 * `GET /session` 是唯一身份来源（契约 §5.1）：运营上下文由后端按运营成员关系判定，
 * 前端不发送 `X-Organization-ID`，也不从 token 里解析角色。
 *
 * 硬约定：返回对象**必须**带 `accessCodes: OpsPermission[]`，
 * 路由/菜单/按钮三层权限呈现都消费该字段（`src/constants/permissions.ts`）。
 */
import type { OpsOperatorStatus, OpsSession } from '#/api/ops/identity/session';
import type { OpsPermission } from '#/constants/permissions';

import { fetchOpsSession } from '#/api/ops/identity/session';
import {
  findUnknownPermissions,
  OPS_PERMISSION_CODES,
} from '#/constants/permissions';

/** 前端会话视图。字段由 `GET /session` 映射，不含任何令牌。 */
export interface OpsUserInfo {
  /** 运营成员 ID（`operator.id`）。 */
  userId: string;
  /** 展示名（`operator.displayName`）。 */
  realName: string;
  /** 登录名：运营后台以邮箱登录，故与 `email` 同值。 */
  username: string;
  email: string;
  /** 契约无头像字段；未提供时由布局层回退默认头像。 */
  avatar?: string;
  /** 角色码列表，仅用于展示与角色配置，**不得**参与权限判定 [PRD §4.2]。 */
  roles: string[];
  /** 权限动作码，唯一授权依据。 */
  accessCodes: OpsPermission[];
  /** 运营后台默认首页：契约未下发，留空由 `preferences.app.defaultHomePath` 兜底。 */
  homePath: string;
  desc: string;
  operatorStatus: OpsOperatorStatus;
  mfaRequired: boolean;
  permissionVersion: number;
  lastLoginAt: null | string;
}

function isOpsPermission(code: string): code is OpsPermission {
  return (OPS_PERMISSION_CODES as readonly string[]).includes(code);
}

/**
 * 把会话响应映射为前端用户信息。
 *
 * 未知权限码不会中断登录：后端允许加法式新增动作码（契约 §2.6），
 * 前端保留已知码并在控制台告警，避免"后端发版即登录失败"。
 */
export function toOpsUserInfo(session: OpsSession): OpsUserInfo {
  const granted = session.permissions ?? [];
  const unknown = findUnknownPermissions(granted);
  if (unknown.length > 0) {
    console.warn(
      '[ops] 收到未登记的权限动作码，请同步 constants/permissions.ts',
      unknown,
    );
  }

  return {
    accessCodes: granted.filter(isOpsPermission),
    desc: session.operator.email,
    email: session.operator.email,
    homePath: '',
    lastLoginAt: session.lastLoginAt ?? null,
    mfaRequired: session.operator.mfaRequired,
    operatorStatus: session.operator.status,
    permissionVersion: session.permissionVersion,
    realName: session.operator.displayName,
    roles: (session.roles ?? []).map((role) => role.code),
    userId: session.operator.id,
    username: session.operator.email,
  };
}

/** 获取当前运营用户信息（含权限动作码）。 */
export async function getUserInfoApi(): Promise<OpsUserInfo> {
  return toOpsUserInfo(await fetchOpsSession());
}
