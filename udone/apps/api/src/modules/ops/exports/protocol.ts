import { z } from '@erp/contracts';
import type { OpsExport, OpsExportDetailResponse, OpsExportListResponse } from '@erp/contracts';

/**
 * 导出任务的出站翻译层（契约 §5.9 三个端点）。
 *
 * 与别的域同一个规矩：SQL 说列名、这里翻成 JS。这一域多出来的部分是
 * **执行期的五个信封**——认领、取数、完成、失败都有自己的返回形态，
 * 它们不经过 HTTP 层，但同样是「库说什么、Node 做什么」的边界，所以
 * 一起在这里声明成 discriminated union，而不是在 runner 里用字符串比较硬猜。
 */

const operatorRefRowSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
});

const exportRowSchema = z.object({
  id: z.uuid(),
  export_no: z.string(),
  export_type: z.enum(['receivables', 'receipts', 'contracts', 'customers', 'tickets']),
  filters: z.record(z.string(), z.unknown()),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'expired']),
  row_count: z.number().int().nullable(),
  storage_path: z.string().nullable(),
  requested_by: operatorRefRowSchema,
  created_at: z.string(),
  completed_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});

export const exportListEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(exportRowSchema) }),
  z.object({ status: z.literal('forbidden') }),
]);

export const exportCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    export: z.object({
      id: z.uuid(),
      export_no: z.string(),
      export_type: z.string(),
      status: z.string(),
    }),
  }),
  z.object({ status: z.literal('unsupported_type'), export_type: z.string().nullable() }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('invalid_filters') }),
]);

export const exportDetailEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    export: exportRowSchema,
    can_download: z.boolean(),
  }),
  z.object({ status: z.literal('not_found') }),
]);

/** `claim_export` 只带执行需要的那几列，不带 `row_count` 这类此刻还为空的东西。 */
export const exportClaimEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    export: z.object({
      id: z.uuid(),
      export_no: z.string(),
      export_type: z.enum(['receivables', 'receipts', 'contracts', 'customers', 'tickets']),
      filters: z.record(z.string(), z.unknown()),
      requested_by: z.uuid(),
    }),
  }),
  z.object({ status: z.literal('empty') }),
]);

export const exportRowsEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    row_count: z.number().int().min(0),
    rows: z.array(z.record(z.string(), z.unknown())),
  }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('not_running'), current_status: z.string() }),
  z.object({ status: z.literal('forbidden'), required_permission: z.string().nullable() }),
  z.object({
    status: z.literal('too_many_rows'),
    row_limit: z.number().int(),
    row_count: z.number().int(),
  }),
]);

export const exportFinishEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), export: exportRowSchema }),
  z.object({ status: z.literal('not_running') }),
]);

export const exportAbortEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('not_running') }),
]);

export function toOpsExport(row: z.infer<typeof exportRowSchema>): OpsExport {
  return {
    id: row.id,
    exportNo: row.export_no,
    exportType: row.export_type,
    filters: row.filters,
    status: row.status,
    rowCount: row.row_count,
    requestedBy: { id: row.requested_by.id, displayName: row.requested_by.display_name },
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

export function toOpsExportList(
  rows: Array<z.infer<typeof exportRowSchema>>,
): OpsExportListResponse {
  return { items: rows.map(toOpsExport) };
}

export function toOpsExportDetail(
  row: z.infer<typeof exportRowSchema>,
  downloadUrl: string | null,
  downloadExpiresAt: string | null,
): OpsExportDetailResponse {
  return {
    export: toOpsExport(row),
    downloadUrl,
    downloadExpiresAt,
    // 顶层 `expiresAt` 与 `export.expiresAt` 是同一个值。契约 §5.9 把它列在
    // `export{...}` 之外，两处都留是为了不逼前端记住「它在里面」。
    expiresAt: row.expires_at,
  };
}
