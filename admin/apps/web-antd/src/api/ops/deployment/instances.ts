/**
 * 部署实例 API（契约 §5.8 `GET|POST /deployments`、`GET|PATCH /deployments/{id}`）。
 *
 * 三条硬约束：
 * 1. **状态只能走 `transition`**：`updateDeployment()` 的可编辑字段里没有 `status`，
 *    也没有 `currentVersion`（当前版本只能由升级登记推进，见 `version-records.ts`）；
 * 2. `PATCH` 必须回传 `version`（契约 §3.0 乐观锁），409 `CONFLICT` 时页面刷新重试；
 * 3. 前端只登记台账，不触发任何远程安装/升级，也不保存任何环境凭据（PRD §6.8）。
 */
import type {
  CreateDeploymentInput,
  CreateDeploymentResult,
  DeploymentDetail,
  DeploymentListQuery,
  DeploymentListResult,
  DeploymentTransitionInput,
  DeploymentTransitionResult,
  UpdateDeploymentInput,
  UpdateDeploymentResult,
} from './types';

import {
  buildDeploymentListParams,
  createIdempotencyKey,
  DEPLOYMENT_ENDPOINTS,
  requestClient,
  writeConfig,
} from './endpoints';

/** 实例列表（服务端分页/筛选）。 */
export async function fetchDeployments(
  query: DeploymentListQuery = {},
): Promise<DeploymentListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListDeployments } = await import('./dev-stub');
    return stubListDeployments(query);
  }
  return requestClient.get<DeploymentListResult>(
    DEPLOYMENT_ENDPOINTS.deployments,
    { params: buildDeploymentListParams(query) },
  );
}

/** 实例详情：基本信息、当前版本记录、关联授权与工单。 */
export async function fetchDeployment(
  deploymentId: string,
): Promise<DeploymentDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetDeployment } = await import('./dev-stub');
    return stubGetDeployment(deploymentId);
  }
  return requestClient.get<DeploymentDetail>(
    DEPLOYMENT_ENDPOINTS.detail(deploymentId),
  );
}

/** 创建实例（状态直接落 `planned`，契约 §3.7 状态机第一行）。 */
export async function createDeployment(
  input: CreateDeploymentInput,
): Promise<CreateDeploymentResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateDeployment } = await import('./dev-stub');
    return stubCreateDeployment(input);
  }
  return requestClient.post<CreateDeploymentResult>(
    DEPLOYMENT_ENDPOINTS.deployments,
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/** 编辑实例基础信息（不含状态与当前版本）。 */
export async function updateDeployment(
  deploymentId: string,
  input: UpdateDeploymentInput,
): Promise<UpdateDeploymentResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubUpdateDeployment } = await import('./dev-stub');
    return stubUpdateDeployment(deploymentId, input);
  }
  return requestClient.request<UpdateDeploymentResult>(
    DEPLOYMENT_ENDPOINTS.detail(deploymentId),
    { data: input, method: 'PATCH' },
  );
}

/**
 * 环境状态流转（契约 §3.7 状态机；端点为契约推导，见 `endpoints.ts` 头注释）。
 *
 * 非法迁移服务端返回 409 `STATE_CONFLICT` + `details.allowedActions`。
 */
export async function transitionDeployment(
  deploymentId: string,
  input: DeploymentTransitionInput,
): Promise<DeploymentTransitionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubTransitionDeployment } = await import('./dev-stub');
    return stubTransitionDeployment(deploymentId, input);
  }
  return requestClient.post<DeploymentTransitionResult>(
    DEPLOYMENT_ENDPOINTS.transition(deploymentId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
