/**
 * identity 域类型。
 *
 * 契约：`Docs/ops-api-contract.md` §5.1。字段名严格照抄，不得自行改名；
 * 新增字段必须先在契约里出现。
 *
 * 注意与 `session.ts` 里 `OpsRole` 的区别：会话响应里的角色只带 `{code,name}`
 * （够渲染标签即可），角色管理端点返回完整定义。刻意不合并——合并会让会话
 * 响应被迫携带 `permissions[]`，而它已经通过 `session.permissions` 单独下发。
 */
import type { OpsOperatorStatus } from './session';

export interface OpsRoleRef {
  code: string;
  name: string;
}

/** `GET /operators` 列表项。 */
export interface OpsOperatorListItem {
  id: string;
  email: string;
  displayName: string;
  status: OpsOperatorStatus;
  roles: OpsRoleRef[];
  lastLoginAt: null | string;
}

/** `GET /roles` 列表项。`isSystem` 系统角色不可改 code、不可删除。 */
export interface OpsRoleDetail {
  id: string;
  code: string;
  name: string;
  description: null | string;
  isSystem: boolean;
  status: 'active' | 'disabled';
  /** 权限动作码，真源为契约 §4。 */
  permissions: string[];
}

/** `GET /audit-events` 列表项。审计为只读事实，无任何写端点。 */
export interface OpsAuditEvent {
  id: string;
  actor: { displayName: string; id: string };
  action: string;
  entityType: string;
  entityId: string;
  reason: null | string;
  /** 变更前后摘要，形状随实体变化，界面只做原样展示与折叠。 */
  beforeSummary: null | Record<string, unknown>;
  afterSummary: null | Record<string, unknown>;
  requestId: null | string;
  createdAt: string;
}

/** `POST /operators/invitations` 请求体（契约标记幂等必填）。 */
export interface InviteOperatorPayload {
  email: string;
  roleCodes: string[];
  reason: string;
}

/** `PATCH /operators/{id}` 请求体。 */
export interface UpdateOperatorPayload {
  mfaRequired?: boolean;
  reason: string;
  roleCodes?: string[];
  status?: OpsOperatorStatus;
  /** 乐观锁版本；契约对该端点标注了 `version` 必填。 */
  version: number;
}

/** `POST /roles` 请求体。 */
export interface CreateRolePayload {
  code: string;
  description?: string;
  name: string;
  permissionCodes: string[];
}

/** `PATCH /roles/{id}` 请求体。 */
export interface UpdateRolePayload {
  description?: string;
  name?: string;
  permissionCodes?: string[];
  reason: string;
  status?: 'active' | 'disabled';
}

export interface OperatorListQuery {
  keyword?: string;
  page?: number;
  pageSize?: number;
  roleCode?: string;
  status?: OpsOperatorStatus;
}

export interface AuditEventListQuery {
  action?: string;
  actorOperatorId?: string;
  entityId?: string;
  entityType?: string;
  from?: string;
  page?: number;
  pageSize?: number;
  requestId?: string;
  to?: string;
}

export interface OpsPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
