import { z } from 'zod';

/**
 * 设置页（契约 §5.9 的 `GET/PATCH /settings` 与三个字典端点）。
 *
 * 三件契约写死了、实现只需照抄的事：
 * - 三个设置项的范围：窗口与导出保留 `1–365` 天，工单时限 `1–720` 小时
 *   （U-21）。越界回 400，不静默截断。
 * - `updatedBy` 是 `{id,displayName}` 对象而不是裸 uuid（U-20）：列表要直接
 *   渲染人名，返回 uuid 会逼前端为每行再查一次。
 * - 字典条目带 `id`（U-19），因为 `PATCH /dictionary-items/{itemId}` 只按它寻址。
 *
 * 一件契约没说、实现必须选的事：`PATCH /settings` 的请求体是**部分对象**，
 * 而不是三个字段全给。理由与 PATCH 的字面语义一致，也与 `ops.settings` 的三行
 * 形状一致——只改一个键时不该把另外两个也「确认一遍」，那会让并发编辑互相
 * 覆盖（两个人各改一项，后到的把前一个改回去）。
 */

export const OPS_SETTINGS_LIMITS = {
  overviewExpiryWindowDays: { min: 1, max: 365 },
  ticketDueHours: { min: 1, max: 720 },
  exportRetentionDays: { min: 1, max: 365 },
} as const;

const operatorRefSchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1),
});

export const opsSettingsSchema = z.object({
  overviewExpiryWindowDays: z
    .number()
    .int()
    .min(OPS_SETTINGS_LIMITS.overviewExpiryWindowDays.min)
    .max(OPS_SETTINGS_LIMITS.overviewExpiryWindowDays.max),
  ticketDueHours: z
    .number()
    .int()
    .min(OPS_SETTINGS_LIMITS.ticketDueHours.min)
    .max(OPS_SETTINGS_LIMITS.ticketDueHours.max),
  exportRetentionDays: z
    .number()
    .int()
    .min(OPS_SETTINGS_LIMITS.exportRetentionDays.min)
    .max(OPS_SETTINGS_LIMITS.exportRetentionDays.max),
});
export type OpsSettings = z.infer<typeof opsSettingsSchema>;

export const opsSettingsResponseSchema = z.object({
  settings: opsSettingsSchema,
  /** 从未有人改过时为 null——前端据此显示「初始值」。 */
  updatedBy: operatorRefSchema.nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type OpsSettingsResponse = z.infer<typeof opsSettingsResponseSchema>;

/*
 * 三个键都可选，但**不能一个都不给**：`PATCH {}` 是一次什么都没说的请求，
 * 让它 200 会让前端以为保存成功。zod 的 refine 在这里比 SQL 的 `empty_patch`
 * 更早一层——两层都留，因为 SQL 还要挡住「绕过端点的调用」。
 */
export const opsSettingsUpdateRequestSchema = z
  .strictObject({
    overviewExpiryWindowDays: z
      .number()
      .int()
      .min(OPS_SETTINGS_LIMITS.overviewExpiryWindowDays.min)
      .max(OPS_SETTINGS_LIMITS.overviewExpiryWindowDays.max)
      .optional(),
    ticketDueHours: z
      .number()
      .int()
      .min(OPS_SETTINGS_LIMITS.ticketDueHours.min)
      .max(OPS_SETTINGS_LIMITS.ticketDueHours.max)
      .optional(),
    exportRetentionDays: z
      .number()
      .int()
      .min(OPS_SETTINGS_LIMITS.exportRetentionDays.min)
      .max(OPS_SETTINGS_LIMITS.exportRetentionDays.max)
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: '至少需要提供一个设置项',
  });
export type OpsSettingsUpdateRequest = z.infer<typeof opsSettingsUpdateRequestSchema>;

// ── 字典 ────────────────────────────────────────────────────────────────────

export const opsDictionaryItemSchema = z.object({
  id: z.uuid(),
  /** 落库的值：工单、收款历史里存的就是它，改文案不动它。 */
  value: z.string().min(1),
  label: z.string().min(1),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});
export type OpsDictionaryItem = z.infer<typeof opsDictionaryItemSchema>;

export const opsDictionarySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  items: z.array(opsDictionaryItemSchema),
});
export type OpsDictionary = z.infer<typeof opsDictionarySchema>;

export const opsDictionaryListQuerySchema = z.object({
  code: z.string().min(1).optional(),
});

export const opsDictionaryListResponseSchema = z.object({
  items: z.array(opsDictionarySchema),
});
export type OpsDictionaryListResponse = z.infer<typeof opsDictionaryListResponseSchema>;

export const opsDictionaryItemCreateRequestSchema = z.strictObject({
  value: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  /** 不传则排到本组末尾（当前最大 + 10），不是排到最前。 */
  sortOrder: z.number().int().optional(),
});
export type OpsDictionaryItemCreateRequest = z.infer<typeof opsDictionaryItemCreateRequestSchema>;

export const opsDictionaryItemCreateResponseSchema = z.object({
  item: opsDictionaryItemSchema,
});
export type OpsDictionaryItemCreateResponse = z.infer<typeof opsDictionaryItemCreateResponseSchema>;

export const opsDictionaryItemUpdateRequestSchema = z
  .strictObject({
    label: z.string().min(1).max(64).optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: '至少需要提供一个字段',
  });
export type OpsDictionaryItemUpdateRequest = z.infer<typeof opsDictionaryItemUpdateRequestSchema>;

export const opsDictionaryItemUpdateResponseSchema = z.object({
  item: opsDictionaryItemSchema,
});
export type OpsDictionaryItemUpdateResponse = z.infer<typeof opsDictionaryItemUpdateResponseSchema>;
