import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  pageNumberSchema,
  pageSizeSchema,
  pagedResponseSchema,
} from '../pagination';

/**
 * tenant-integration 域（契约 §3.6 / §5.7，十个端点：租户映射与租户命令）。
 *
 * 这一域对外只有一句话需要说清：**202 不是「做完了」，是「受理了」**。
 * 所以出口形状里没有 `success` 这种字段，只有 `status` 五个取值，而其中
 * 只有 `succeeded` 代表远端确认过。
 *
 * 三处口径：
 *
 * 1. **`udoneOrganizationId` 可空。** 建映射时租户往往还不存在（`provision`
 *    命令存在的理由就是这个），`externalRef` 也只是个对账用的外部编号。
 *    空不是缺失，是「还没绑上」。要绑只能走 PATCH，且只在 `pending` 期间——
 *    已经生效的映射改绑等于把授权悄悄指向另一个客户。
 * 2. **`retryable` 只回答「现在还能不能重试」**，不含权限。权限在端点层判
 *    （`tenant.retry` + 原命令的动作码）；把权限揉进这个字段，会让同一个
 *    字段在有权限的人眼里是 true、别人眼里是 false，接口就没法缓存也没法断言。
 * 3. **没有任何端点能改命令状态。** `pending → succeeded` 只有下发方能写，
 *    运营端只有 `retry` 与 `cancel`。所以这里的请求 schema 里找不到
 *    `status` 字段——不是漏了，是不允许。
 */

export const OPS_TENANT_MAPPING_STATUSES = [
  'pending',
  'active',
  'suspended',
  'terminated',
] as const;
export const opsTenantMappingStatusSchema = z.enum(OPS_TENANT_MAPPING_STATUSES);
export type OpsTenantMappingStatus = z.infer<typeof opsTenantMappingStatusSchema>;

export const OPS_TENANT_COMMAND_TYPES = [
  'provision',
  'bind',
  'activate',
  'suspend',
  'resume',
  'sync_entitlement',
  'extend',
  'revoke',
] as const;
export const opsTenantCommandTypeSchema = z.enum(OPS_TENANT_COMMAND_TYPES);
export type OpsTenantCommandType = z.infer<typeof opsTenantCommandTypeSchema>;

export const OPS_TENANT_COMMAND_STATUSES = [
  'pending',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const opsTenantCommandStatusSchema = z.enum(OPS_TENANT_COMMAND_STATUSES);
export type OpsTenantCommandStatus = z.infer<typeof opsTenantCommandStatusSchema>;

export const OPS_TENANT_ERROR_CATEGORIES = [
  'transient',
  'permanent',
  'auth',
  'conflict',
  'unknown',
] as const;
export const opsTenantErrorCategorySchema = z.enum(OPS_TENANT_ERROR_CATEGORIES);
export type OpsTenantErrorCategory = z.infer<typeof opsTenantErrorCategorySchema>;

export const OPS_TENANT_ATTEMPT_OUTCOMES = ['succeeded', 'failed', 'timeout'] as const;
export const opsTenantAttemptOutcomeSchema = z.enum(OPS_TENANT_ATTEMPT_OUTCOMES);
export type OpsTenantAttemptOutcome = z.infer<typeof opsTenantAttemptOutcomeSchema>;

/**
 * 运营端能对命令做的两个动作（契约 §3.6）。
 *
 * `dispatch_success` / `dispatch_fail_*` / `timeout` 不在这里：它们是系统侧
 * 的边，只能由下发方写。把它们放进枚举等于在类型层面允许运营端自称「发成功了」。
 */
export const OPS_TENANT_COMMAND_ACTIONS = ['retry', 'cancel'] as const;
export const opsTenantCommandActionSchema = z.enum(OPS_TENANT_COMMAND_ACTIONS);
export type OpsTenantCommandAction = z.infer<typeof opsTenantCommandActionSchema>;

// ── 出站形状 ─────────────────────────────────────────────────────────────────

export const opsTenantCustomerRefSchema = z.object({
  id: z.uuid(),
  customerNo: z.string().min(1),
  name: z.string().min(1),
});
export type OpsTenantCustomerRef = z.infer<typeof opsTenantCustomerRefSchema>;

export const opsTenantProductRefSchema = z.object({
  id: z.uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
});
export type OpsTenantProductRef = z.infer<typeof opsTenantProductRefSchema>;

export const opsTenantMappingSchema = z.object({
  id: z.uuid(),
  mappingNo: z.string().min(1),
  customer: opsTenantCustomerRefSchema,
  product: opsTenantProductRefSchema,
  /** 还没绑上时是 null，不是空字符串——「没有」和「空」在这一域必须分开。 */
  udoneOrganizationId: z.uuid().nullable(),
  externalRef: z.string().nullable(),
  mappingStatus: opsTenantMappingStatusSchema,
  /** 远端最近一次自报的状态。与 `mappingStatus` 不同：后者是我们认为的。 */
  lastKnownState: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  /** 乐观锁。只在远端确认后 +1，失败与超时都不动。 */
  syncVersion: z.number().int().min(0),
  version: z.number().int().min(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsTenantMapping = z.infer<typeof opsTenantMappingSchema>;

/**
 * 一条租户命令。
 *
 * `requestSummary` / `responseSummary` 是 `z.unknown().nullable()` 而不是具体
 * 形状：它们是「给远端发了什么、远端回了什么」的摘要，远端契约不在本仓库。
 * 给它们定一个 zod 形状，等于假设远端的字段名，第一次对接就会 503。
 */
export const opsTenantCommandSchema = z.object({
  id: z.uuid(),
  commandNo: z.string().min(1),
  mappingId: z.uuid().nullable(),
  commandType: opsTenantCommandTypeSchema,
  customerId: z.uuid().nullable(),
  contractId: z.uuid().nullable(),
  changeRequestId: z.uuid().nullable(),
  expectedSyncVersion: z.number().int().min(0).nullable(),
  reason: z.string().min(1),
  status: opsTenantCommandStatusSchema,
  attemptCount: z.number().int().min(0),
  lastErrorCode: z.string().nullable(),
  lastErrorCategory: opsTenantErrorCategorySchema.nullable(),
  requestSummary: z.unknown().nullable(),
  responseSummary: z.unknown().nullable(),
  requestId: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string().min(1),
  completedAt: z.string().nullable(),
  version: z.number().int().min(0),
});
export type OpsTenantCommand = z.infer<typeof opsTenantCommandSchema>;

export const opsTenantCommandAttemptSchema = z.object({
  id: z.uuid(),
  commandId: z.uuid(),
  attemptNo: z.number().int().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable(),
  outcome: opsTenantAttemptOutcomeSchema,
  httpStatus: z.number().int().nullable(),
  errorCategory: opsTenantErrorCategorySchema.nullable(),
  requestId: z.string().nullable(),
  responseSummary: z.unknown().nullable(),
  actorId: z.uuid().nullable(),
});
export type OpsTenantCommandAttempt = z.infer<typeof opsTenantCommandAttemptSchema>;

// ── 入站请求 ─────────────────────────────────────────────────────────────────

export const opsTenantMappingCreateRequestSchema = z.strictObject({
  customerId: z.uuid(),
  productId: z.uuid(),
  /** 只有「远端已经建好了、这里补录」时才传（见 §5.7 的可选标记）。 */
  udoneOrganizationId: z.uuid().optional(),
  externalRef: z.string().trim().max(120).optional(),
  reason: z.string().trim().max(500).optional(),
});
export type OpsTenantMappingCreateRequest = z.infer<typeof opsTenantMappingCreateRequestSchema>;

/**
 * PATCH 的两个字段都可选，但「没传」与「传 null」不是一回事：
 * 前者是「别动」，后者是「清空 `externalRef`」。所以这里用 `.optional()`
 * 而不是 `.nullable()`——想清空就传空字符串，服务端会存成 null。
 */
export const opsTenantMappingUpdateRequestSchema = z.strictObject({
  udoneOrganizationId: z.uuid().optional(),
  externalRef: z.string().trim().max(120).optional(),
  version: z.number().int().min(0),
});
export type OpsTenantMappingUpdateRequest = z.infer<typeof opsTenantMappingUpdateRequestSchema>;

/**
 * 下发内容。
 *
 * 只收三种：新增/修改的功能项、生效日、失效日。远端需要什么别的参数，说明
 * 远端契约变了；那时候应该改这里，而不是开一个 `z.record(z.unknown())`
 * 让任何东西都能塞进去——后者会让「客户 A 的 payload 里带了客户 B 的 id」
 * 这种事故在类型层面完全合法。
 */
export const opsTenantCommandPayloadSchema = z.strictObject({
  features: z
    .array(
      z.strictObject({
        featureKey: z.string().trim().min(1).max(80),
        enabled: z.boolean().optional(),
        quota: z.number().min(0).nullable().optional(),
        termMonths: z.number().int().min(1).nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
  validFrom: z.iso.date().optional(),
  validTo: z.iso.date().optional(),
});
export type OpsTenantCommandPayload = z.infer<typeof opsTenantCommandPayloadSchema>;

export const opsTenantCommandCreateRequestSchema = z.strictObject({
  commandType: opsTenantCommandTypeSchema,
  reason: z.string().trim().min(1).max(500),
  contractId: z.uuid().optional(),
  changeRequestId: z.uuid().optional(),
  /** 乐观锁值。省略即「不看版本」，仅用于对账类的幂等重放。 */
  expectedSyncVersion: z.number().int().min(0).optional(),
  payload: opsTenantCommandPayloadSchema.optional(),
});
export type OpsTenantCommandCreateRequest = z.infer<typeof opsTenantCommandCreateRequestSchema>;

export const opsTenantCommandTransitionRequestSchema = z.strictObject({
  action: opsTenantCommandActionSchema,
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().min(0).optional(),
});
export type OpsTenantCommandTransitionRequest = z.infer<
  typeof opsTenantCommandTransitionRequestSchema
>;

export const opsTenantMappingListQuerySchema = z.object({
  customerId: z.uuid().optional(),
  mappingStatus: opsTenantMappingStatusSchema.optional(),
  productId: z.uuid().optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsTenantMappingListQuery = z.infer<typeof opsTenantMappingListQuerySchema>;

export const opsTenantCommandListQuerySchema = z.object({
  mappingId: z.uuid().optional(),
  status: z.array(opsTenantCommandStatusSchema).optional(),
  commandType: opsTenantCommandTypeSchema.optional(),
  /** 右端开区间：传日期时按整天切，闭区间会漏掉当天最后一毫秒之后的那条。 */
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdTo: z.iso.datetime({ offset: true }).optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsTenantCommandListQuery = z.infer<typeof opsTenantCommandListQuerySchema>;

// ── 出站响应 ─────────────────────────────────────────────────────────────────

export const opsTenantMappingListResponseSchema = pagedResponseSchema(opsTenantMappingSchema);
export type OpsTenantMappingListResponse = z.infer<typeof opsTenantMappingListResponseSchema>;

export const opsTenantMappingCreateResponseSchema = z.object({
  mapping: opsTenantMappingSchema,
});
export type OpsTenantMappingCreateResponse = z.infer<typeof opsTenantMappingCreateResponseSchema>;

export const opsTenantMappingDetailResponseSchema = z.object({
  mapping: opsTenantMappingSchema,
  /** 契约 §5.7 的「最近 20 条」，按创建时间倒序。 */
  commands: z.array(opsTenantCommandSchema),
});
export type OpsTenantMappingDetailResponse = z.infer<typeof opsTenantMappingDetailResponseSchema>;

export const opsTenantMappingUpdateResponseSchema = z.object({
  mapping: opsTenantMappingSchema,
});
export type OpsTenantMappingUpdateResponse = z.infer<typeof opsTenantMappingUpdateResponseSchema>;

/**
 * 建命令的响应是 202：`command.status` 恒为 `pending`，`commandNo` 是让调用方
 * 之后能对上远端操作记录的那个号。`mapping` 一起回，是因为调用方通常紧接着要
 * 用新的 `syncVersion` 发下一条命令——不回就得再查一次。
 */
export const opsTenantCommandCreateResponseSchema = z.object({
  command: opsTenantCommandSchema,
  mapping: opsTenantMappingSchema.nullable(),
});
export type OpsTenantCommandCreateResponse = z.infer<typeof opsTenantCommandCreateResponseSchema>;

export const opsTenantCommandListResponseSchema = pagedResponseSchema(opsTenantCommandSchema);
export type OpsTenantCommandListResponse = z.infer<typeof opsTenantCommandListResponseSchema>;

export const opsTenantCommandDetailResponseSchema = z.object({
  command: opsTenantCommandSchema,
  attempts: z.array(opsTenantCommandAttemptSchema),
  retryable: z.boolean(),
});
export type OpsTenantCommandDetailResponse = z.infer<typeof opsTenantCommandDetailResponseSchema>;

export const opsTenantCommandAttemptListResponseSchema = pagedResponseSchema(
  opsTenantCommandAttemptSchema,
);
export type OpsTenantCommandAttemptListResponse = z.infer<
  typeof opsTenantCommandAttemptListResponseSchema
>;

export const opsTenantCommandTransitionResponseSchema = z.object({
  command: opsTenantCommandSchema,
});
export type OpsTenantCommandTransitionResponse = z.infer<
  typeof opsTenantCommandTransitionResponseSchema
>;
