/**
 * 导出任务（契约 §5.9 `/exports`）。
 *
 * 导出一律异步（U-14）：`POST /exports` 返回 **202** + `status='queued'`，
 * 之后由后台任务推进到 `running` / `succeeded` / `failed` / `expired`。
 *
 * 两条前端纪律：
 * 1. **不在浏览器里「等它完成」**：创建成功后只提示「已排队」，状态由页面按需刷新
 *    （用户手动刷新或有限次轮询），不阻塞、不假报成功。
 * 2. **下载地址现取现用**：签名 URL 有效期 ≤ 5 分钟（契约 §5.9），列表项没有该字段；
 *    点击下载时必须再取一次详情，且不得把 URL 缓存到内存之外的地方。
 */
import type {
  CreateExportPayload,
  CreateExportResult,
  OpsExportListQuery,
  OpsExportTask,
  OpsPage,
} from './types';

import { requestClient } from '#/api/request';

import { OPS_ENDPOINTS, writeConfig } from './endpoints';

/** 单值筛选字段白名单（多值的 `status` 单独处理成 `status[]`）。 */
const EXPORT_FILTER_KEYS = [
  'exportType',
  'requestedBy',
  'page',
  'pageSize',
] as const;

/** 组装列表参数：只透传白名单，避免把界面状态对象整体发给后端。 */
export function buildExportListParams(
  query: OpsExportListQuery,
): Record<string, unknown> {
  const source = query as unknown as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const key of EXPORT_FILTER_KEYS) {
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params[key] = value;
  }
  if (query.status && query.status.length > 0) {
    params['status[]'] = [...query.status];
  }
  return params;
}

/** 导出任务列表（需 `export.read`，服务端分页）。 */
export async function fetchExportTasks(
  query: OpsExportListQuery = {},
): Promise<OpsPage<OpsExportTask>> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListExportTasks } = await import('./dev-stub');
    return stubListExportTasks(query);
  }
  return requestClient.get<OpsPage<OpsExportTask>>(OPS_ENDPOINTS.exportTasks, {
    params: buildExportListParams(query),
  });
}

/**
 * 发起导出（需 `export.create`，幂等必填，高风险动作）。
 *
 * 幂等键必须由调用方在**打开弹窗时**生成一次：同一次提交在网络重试下复用同 key，
 * 服务端才能识别为重放而不是又排一个任务。若每次点击都重新生成，
 * 「点了两次」就会真的导出两份——这正是幂等键要防的情况。
 */
export async function createExport(
  payload: CreateExportPayload,
  idempotencyKey: string,
): Promise<CreateExportResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateExport } = await import('./dev-stub');
    return stubCreateExport(payload);
  }
  return requestClient.post<CreateExportResult>(
    OPS_ENDPOINTS.exportTasks,
    payload,
    writeConfig(idempotencyKey),
  );
}

/**
 * 导出任务详情（需 `export.read`）。`downloadUrl` 只在这里出现，且很快过期。
 */
export async function fetchExportTask(
  exportId: string,
): Promise<OpsExportTask> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetExportTask } = await import('./dev-stub');
    return stubGetExportTask(exportId);
  }
  return requestClient.get<OpsExportTask>(OPS_ENDPOINTS.exportTask(exportId));
}
