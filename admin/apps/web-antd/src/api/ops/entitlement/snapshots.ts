/**
 * 权益快照查询 API（契约 §5.6 `GET /entitlement-snapshots/{snapshotId}`）。
 *
 * 快照是**只追加**的事实（契约 §3.5：`entitlement_snapshots` / `_lines` 仅 INSERT，
 * 由 RPC 以 owner 权限写入）。因此本文件只有 `get` / `list`，**没有** update/delete：
 * 任何权益调整都必须新增变更申请并生成新快照（源码参考门 §3.4）。
 *
 * 契约推导：§5.6 只定义按 id 查单条；快照历史列表（`GET /entitlement-snapshots`）
 * 由「历史可回溯、不可覆写」推导，登记为 journal U-06。若后端未提供该端点，
 * 页面回退到详情响应里的 `snapshots[]`，不伪造历史。
 */
import type {
  EntitlementSnapshot,
  SnapshotListQuery,
  SnapshotListResult,
} from './types';

import {
  buildEntitlementListParams,
  ENTITLEMENT_ENDPOINTS,
  requestClient,
} from './endpoints';

const SNAPSHOT_FILTER_KEYS = [
  'customerId',
  'sourceType',
  'sourceId',
  'targetScope',
] as const;

/** 单条快照（含全部权益行）。 */
export async function fetchSnapshot(
  snapshotId: string,
): Promise<EntitlementSnapshot> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetSnapshot } = await import('./dev-stub');
    return stubGetSnapshot(snapshotId);
  }
  return requestClient.get<EntitlementSnapshot>(
    ENTITLEMENT_ENDPOINTS.snapshot(snapshotId),
  );
}

/**
 * 快照历史（只读列表，服务端按 `createdAt` 倒序）。
 * 仅用于：详情未回带 `snapshots[]` 时补齐历史视图。
 */
export async function fetchSnapshotHistory(
  query: SnapshotListQuery = {},
): Promise<SnapshotListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListSnapshots } = await import('./dev-stub');
    return stubListSnapshots(query);
  }
  return requestClient.get<SnapshotListResult>(
    ENTITLEMENT_ENDPOINTS.snapshots,
    { params: buildEntitlementListParams(query, SNAPSHOT_FILTER_KEYS) },
  );
}
