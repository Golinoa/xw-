/**
 * 运营成员管理（契约 §5.1）。
 *
 * ## 幂等键作为必填参数
 *
 * 每个写函数都要求调用方显式传入 `idempotencyKey`，而不是在函数内部生成。
 * 内部生成看似省事，但「连点两次提交」会各自生成新键，服务端识别为两次独立
 * 请求——正是幂等键要防的情况。由调用方在**打开表单时**生成一次并持有到
 * 提交结束，才能真正去重。设为必填参数可让「忘记带键」在 typecheck 阶段
 * 就失败，而不是等后端返回 400 `VALIDATION_ERROR`。
 */
import type {
  InviteOperatorPayload,
  OperatorListQuery,
  OpsOperatorListItem,
  OpsPage,
  UpdateOperatorPayload,
} from './types';

import { requestClient } from '#/api/request';

import { compactParams, OPS_ENDPOINTS, writeConfig } from './endpoints';

/** 运营成员列表（需 `operator.read`）。 */
export async function fetchOperators(
  query: OperatorListQuery = {},
): Promise<OpsPage<OpsOperatorListItem>> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListOperators } = await import('./dev-stub');
    return stubListOperators(query);
  }
  return requestClient.get<OpsPage<OpsOperatorListItem>>(
    OPS_ENDPOINTS.operators,
    { params: compactParams(query as Record<string, unknown>) },
  );
}

/**
 * 邀请运营成员（需 `operator.manage`，幂等必填）。
 *
 * 成功返回 `status='invited'` 的成员与邀请有效期。邀请走 service_role，
 * 被邀请人需自行完成注册——因此这里的「成功」只表示邀请已发出，
 * 不等于账号可用，界面不应提示「已开通」。
 */
export async function inviteOperator(
  payload: InviteOperatorPayload,
  idempotencyKey: string,
): Promise<{
  invitationExpiresAt: string;
  operator: { id: string; status: 'invited' };
}> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubInviteOperator } = await import('./dev-stub');
    return stubInviteOperator(payload);
  }
  return requestClient.post(
    OPS_ENDPOINTS.operatorInvitations,
    payload,
    writeConfig(idempotencyKey),
  );
}

/**
 * 修改成员状态 / 角色 / MFA（需 `operator.manage`，幂等必填）。
 *
 * `version` 必传（契约对 PATCH 要求乐观锁）：不传即为「无条件覆盖」，
 * 并发下会把别人的改动冲掉。
 */
export async function updateOperator(
  operatorId: string,
  payload: UpdateOperatorPayload,
  idempotencyKey: string,
): Promise<{
  operator: OpsOperatorListItem;
  permissionsChanged: { added: string[]; removed: string[] };
}> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubUpdateOperator } = await import('./dev-stub');
    return stubUpdateOperator(operatorId, payload);
  }
  return requestClient.request(OPS_ENDPOINTS.operator(operatorId), {
    data: payload,
    headers: writeConfig(idempotencyKey).headers,
    method: 'PATCH',
  });
}
