/**
 * 审计事件查询（契约 §5.1）。
 *
 * 审计是**只读事实**：契约里没有任何写审计的端点，审计记录由后端在动作发生时
 * 落库。因此本文件只有查询函数，没有 `create` / `update` / `delete`——如果将来
 * 有人想「补一条审计」，应当去改产生该动作的那个端点，而不是在这里加写接口。
 */
import type { AuditEventListQuery, OpsAuditEvent, OpsPage } from './types';

import { requestClient } from '#/api/request';

import { compactParams, OPS_ENDPOINTS } from './endpoints';

/** 审计事件列表（需 `audit.read`）。 */
export async function fetchAuditEvents(
  query: AuditEventListQuery = {},
): Promise<OpsPage<OpsAuditEvent>> {
  return requestClient.get<OpsPage<OpsAuditEvent>>(OPS_ENDPOINTS.auditEvents, {
    params: compactParams(query as Record<string, unknown>),
  });
}
