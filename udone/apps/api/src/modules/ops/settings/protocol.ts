import { z } from '@erp/contracts';
import type {
  OpsDictionaryItem,
  OpsDictionaryListResponse,
  OpsSettingsResponse,
} from '@erp/contracts';

/**
 * 设置页的出站翻译层（契约 §5.9 的五个端点：settings 两组 + 字典三组）。
 *
 * 与别的域同一个规矩：SQL 说列名、这里翻成 JS；每一处键名都对得上 SQL 里的
 * `jsonb_build_object`，多一个少一个都会被出站 zod 抓到。
 *
 * 这一域多一层：**错误也是信封**。`update_ops_settings` 有四种拒绝理由
 * （空补丁 / 未知键 / 类型错 / 越界），它们都要变成 400 + 可定位的 `details`，
 * 所以错误分支也在这里声明成 discriminated union 的成员，而不是在路由里
 * 用 `if (result.status === ...)` 一串字符串比较硬猜。
 */

const operatorRefRowSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
});

const settingsRowSchema = z.object({
  overview_expiry_window_days: z.number().int(),
  ticket_due_hours: z.number().int(),
  export_retention_days: z.number().int(),
});

const settingsPayloadSchema = z.object({
  settings: settingsRowSchema,
  updated_by: operatorRefRowSchema.nullable(),
  updated_at: z.string().nullable(),
});

export const settingsEnvelopeSchema = z.discriminatedUnion('status', [
  settingsPayloadSchema.extend({ status: z.literal('ok') }),
  z.object({ status: z.literal('empty_patch') }),
  z.object({ status: z.literal('unknown_key'), key: z.string() }),
  z.object({ status: z.literal('invalid_value'), field: z.string(), value: z.unknown() }),
  z.object({
    status: z.literal('out_of_range'),
    field: z.string(),
    value: z.number().int(),
    min: z.number().int(),
    max: z.number().int(),
  }),
]);

const dictionaryItemRowSchema = z.object({
  id: z.uuid(),
  value: z.string(),
  label: z.string(),
  sort_order: z.number().int(),
  is_active: z.boolean(),
});

const dictionaryRowSchema = z.object({
  code: z.string(),
  name: z.string(),
  items: z.array(dictionaryItemRowSchema),
});

export const dictionaryListEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(dictionaryRowSchema) }),
  z.object({ status: z.literal('forbidden') }),
]);

export const dictionaryItemEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), item: dictionaryItemRowSchema }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('empty_patch') }),
  z.object({ status: z.literal('value_required') }),
  z.object({ status: z.literal('label_required') }),
  z.object({ status: z.literal('invalid_value'), field: z.string(), value: z.unknown() }),
  z.object({ status: z.literal('dictionary_not_found'), code: z.string() }),
  z.object({ status: z.literal('duplicate_value'), value: z.string(), item_id: z.uuid() }),
]);

export function toSettingsEnvelope(
  row: z.infer<typeof settingsPayloadSchema>,
): OpsSettingsResponse {
  return {
    settings: {
      overviewExpiryWindowDays: row.settings.overview_expiry_window_days,
      ticketDueHours: row.settings.ticket_due_hours,
      exportRetentionDays: row.settings.export_retention_days,
    },
    updatedBy:
      row.updated_by === null
        ? null
        : { id: row.updated_by.id, displayName: row.updated_by.display_name },
    updatedAt: row.updated_at,
  };
}

export function toDictionaryItem(row: z.infer<typeof dictionaryItemRowSchema>): OpsDictionaryItem {
  return {
    id: row.id,
    value: row.value,
    label: row.label,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export function toDictionaryList(
  rows: Array<z.infer<typeof dictionaryRowSchema>>,
): OpsDictionaryListResponse {
  return {
    items: rows.map((row) => ({
      code: row.code,
      name: row.name,
      items: row.items.map(toDictionaryItem),
    })),
  };
}
