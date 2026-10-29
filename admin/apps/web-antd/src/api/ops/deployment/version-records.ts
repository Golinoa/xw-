/**
 * 版本升级记录 API（契约 §5.8 `POST|GET /deployments/{id}/version-records`）。
 *
 * 两条不可协商的约束：
 * 1. **只有读与追加**：`ops.deployment_version_records` 仅 INSERT（契约 §3.7），
 *    因此本文件不导出任何 update/delete 函数，页面也不可能提供编辑入口；
 * 2. 登记的是**已执行的结果**，不是「发起远程升级」：后端不执行安装，
 *    前端也不得出现「立即升级」「远程执行」这类承诺（PRD §6.8）。
 *
 * `fromVersion` 必须等于实例当前版本，否则 409 `STATE_CONFLICT` +
 * `details.reason='VERSION_MISMATCH'`（契约 §6.4）。
 */
import type {
  CreateVersionRecordInput,
  CreateVersionRecordResult,
  VersionRecordListResult,
} from './types';

import {
  createIdempotencyKey,
  DEPLOYMENT_ENDPOINTS,
  requestClient,
  writeConfig,
} from './endpoints';

/** 某个实例的升级历史（服务端按 `executed_on` 倒序返回）。 */
export async function fetchVersionRecords(
  deploymentId: string,
): Promise<VersionRecordListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListVersionRecords } = await import('./dev-stub');
    return stubListVersionRecords(deploymentId);
  }
  return requestClient.get<VersionRecordListResult>(
    DEPLOYMENT_ENDPOINTS.versionRecords(deploymentId),
  );
}

/** 登记一条升级结果（仅追加）。 */
export async function createVersionRecord(
  deploymentId: string,
  input: CreateVersionRecordInput,
): Promise<CreateVersionRecordResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateVersionRecord } = await import('./dev-stub');
    return stubCreateVersionRecord(deploymentId, input);
  }
  return requestClient.post<CreateVersionRecordResult>(
    DEPLOYMENT_ENDPOINTS.versionRecords(deploymentId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
