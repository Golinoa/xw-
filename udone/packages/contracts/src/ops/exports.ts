import { z } from 'zod';

/**
 * 导出任务（契约 §5.9 三个端点、§3.9 `ops.exports`、T-13）。
 *
 * 这一域的形状有三件事是契约定死、实现只需照抄的：
 *
 * - **`requestedBy` 是 `{id,displayName}` 对象**（U-20），不是裸 uuid；理由与
 *   `GET /settings` 的 `updatedBy` 一样：列表要直接渲染人名。
 * - **`POST` 是 202 + `status='queued'`**：发起只写任务行，取数在之后任意一次
 *   列表/详情请求里发生（懒执行）。响应体因此只有三个键，不给「以为已经好了」
 *   留下误读空间。
 * - **`downloadUrl` 是可选字段**：一个能看见任务、但对这类数据没有读权限的人，
 *   拿到的是一个没有 `downloadUrl` 的详情——不是 403，也不是一个点不开的链接。
 *
 * 一件契约没说、实现必须选的事：**`filters` 只接受筛选键，排序与分页键被忽略**。
 * 导出是一份全量文件，顺序由服务端定。若让 `filters` 决定排序，API 层那张
 * 「camelCase → 列名」的白名单映射就得在 SQL 里再写一份，而两份映射迟早会分叉。
 *
 * 另一件没说的事：**产物是数据行，不是 DTO**。CSV 的列名是数据库列名
 * （`customer_no` 而不是 `customerNo`），嵌套对象是 JSON 字符串。理由同上——
 * 为五个域各维护一份「DTO 列名 + 嵌套展开规则」的映射表，是第二真源，而且
 * 它一定会落后于 DTO 的改动。要中文表头或指定列序，应该另做一层"报表模板"，
 * 而不是把 DTO 形状塞进导出。
 */

export const OPS_EXPORT_TYPES = [
  'receivables',
  'receipts',
  'contracts',
  'customers',
  'tickets',
] as const;
export const opsExportTypeSchema = z.enum(OPS_EXPORT_TYPES);
export type OpsExportType = z.infer<typeof opsExportTypeSchema>;

/**
 * 五个状态里 `expired` 不是「删掉了」：产物仍在存储里，只是过了保留期，
 * 再签下载地址就绕过了 `settings.retention.exportDays`。
 */
export const OPS_EXPORT_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'expired'] as const;
export const opsExportStatusSchema = z.enum(OPS_EXPORT_STATUSES);
export type OpsExportStatus = z.infer<typeof opsExportStatusSchema>;

const operatorRefSchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1),
});

export const opsExportSchema = z.object({
  id: z.uuid(),
  exportNo: z.string(),
  exportType: opsExportTypeSchema,
  /** 发起时的筛选条件，原样回传。回放它是审计的一半：`filters` 能回答「这份文件是什么范围」。 */
  filters: z.record(z.string(), z.unknown()),
  status: opsExportStatusSchema,
  /** 只有 `succeeded` 有值；`queued` / `running` / `failed` 一律 null。 */
  rowCount: z.number().int().min(0).nullable(),
  requestedBy: operatorRefSchema,
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  /** 产物过期时间：保留期由 `settings.retention.exportDays` 决定（1–365 天）。 */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export type OpsExport = z.infer<typeof opsExportSchema>;

/**
 * `status[]` 用数组，与其余列表一致（重复 query 参数）。
 *
 * 不加分页：契约 §5.9 的 `GET /exports` 没有 `page` / `pageSize`。这在本域是可
 * 接受的——导出任务是低频操作，一年也不会攒出一屏；给一个假分页反而会让前端
 * 以为要处理翻页。
 */
export const opsExportListQuerySchema = z.object({
  exportType: opsExportTypeSchema.optional(),
  status: z.array(opsExportStatusSchema).optional(),
  requestedBy: z.uuid().optional(),
});
export type OpsExportListQuery = z.infer<typeof opsExportListQuerySchema>;

export const opsExportListResponseSchema = z.object({
  items: z.array(opsExportSchema),
});
export type OpsExportListResponse = z.infer<typeof opsExportListResponseSchema>;

/**
 * 发起导出。
 *
 * `reason` 必填（U-17）：`export.create` 是高风险动作，审计要能回答「为什么导」。
 * 一个空格不算理由，服务端 `trim` 之后还会再判一次。
 *
 * `filters` 缺省为 `{}`（= 全量）。允许全量是有意的：导出最常见的用法就是
 * 「给我一份所有的」，逼调用方传一个空筛选反而是形式主义。
 */
export const opsExportCreateRequestSchema = z.strictObject({
  exportType: opsExportTypeSchema,
  filters: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(1).max(500),
});
export type OpsExportCreateRequest = z.infer<typeof opsExportCreateRequestSchema>;

/**
 * 202 的响应：只回「任务建好了」这一件事。
 *
 * 不带 `rowCount`、不带 `downloadUrl`——此刻都还不存在。留一个 null 字段会让
 * 调用方写成 `if (res.downloadUrl)` 之后永远进不去，而问题不在那段代码。
 */
export const opsExportCreateResponseSchema = z.object({
  export: z.object({
    id: z.uuid(),
    exportNo: z.string(),
    exportType: opsExportTypeSchema,
    status: opsExportStatusSchema,
  }),
});
export type OpsExportCreateResponse = z.infer<typeof opsExportCreateResponseSchema>;

/**
 * 详情。
 *
 * 三个 `download*` / `expiresAt` 都是 nullable 而不是 optional：`optional` 在
 * JSON 里表现为「键不存在」，前端写 `data.downloadUrl ?? null` 与 `data.downloadUrl`
 * 两种写法都能过类型检查，而其中一种会在 `undefined` 上渲染出 `"undefined"`。
 */
export const opsExportDetailResponseSchema = z.object({
  export: opsExportSchema,
  downloadUrl: z.string().nullable(),
  downloadExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export type OpsExportDetailResponse = z.infer<typeof opsExportDetailResponseSchema>;
