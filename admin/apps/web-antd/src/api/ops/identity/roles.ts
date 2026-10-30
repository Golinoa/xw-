/**
 * 角色与权限配置（契约 §5.1）。
 *
 * 角色是权限动作码的集合，动作码真源为契约 §4。前端不校验「哪些码可以组合」——
 * 那是后端与审计的职责；前端只负责把「改了哪些权限」如实展示给操作者，
 * 并强制填写 `reason`（角色变更属高风险动作 `role.manage`）。
 *
 * 幂等键同样作为必填参数，理由见 `operators.ts` 顶部说明。
 */
import type {
  CreateRolePayload,
  OpsPage,
  OpsRoleDetail,
  UpdateRolePayload,
} from './types';

import { requestClient } from '#/api/request';

import { OPS_ENDPOINTS, writeConfig } from './endpoints';

/** 角色列表（需 `operator.read`）。 */
export async function fetchRoles(): Promise<OpsPage<OpsRoleDetail>> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListRoles } = await import('./dev-stub');
    return stubListRoles();
  }
  return requestClient.get<OpsPage<OpsRoleDetail>>(OPS_ENDPOINTS.roles);
}

/** 创建角色（需 `role.manage`，幂等必填）。`code` 创建后不可改。 */
export async function createRole(
  payload: CreateRolePayload,
  idempotencyKey: string,
): Promise<OpsRoleDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateRole } = await import('./dev-stub');
    return stubCreateRole(payload);
  }
  return requestClient.post(
    OPS_ENDPOINTS.roles,
    payload,
    writeConfig(idempotencyKey),
  );
}

/**
 * 修改角色（需 `role.manage`，幂等必填）。
 *
 * 响应回带 `beforePermissions` / `afterPermissions`，用于界面展示「本次改了什么」。
 * 系统角色（`isSystem=true`）不可改 `code`、不可删除，改权限也应由后端拒绝，
 * 前端据此禁用编辑入口，但**不替代后端校验**。
 */
export async function updateRole(
  roleId: string,
  payload: UpdateRolePayload,
  idempotencyKey: string,
): Promise<{
  afterPermissions: string[];
  beforePermissions: string[];
  role: OpsRoleDetail;
}> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubUpdateRole } = await import('./dev-stub');
    return stubUpdateRole(roleId, payload);
  }
  return requestClient.request(OPS_ENDPOINTS.role(roleId), {
    data: payload,
    headers: writeConfig(idempotencyKey).headers,
    method: 'PATCH',
  });
}
