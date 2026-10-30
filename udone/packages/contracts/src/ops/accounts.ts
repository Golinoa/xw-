import { z } from 'zod';
import { listQuerySchema, pagedResponseSchema } from '../pagination';

/**
 * 运营账号、角色与审计查询（契约 §5.1 的七个端点）。
 *
 * 与 `session.ts` 分开：那份是「我自己是谁」，这份是「别人是谁、谁能做什么」。
 * 混在一个文件里，最容易发生的事是编辑页顺手 import 了 `/session` 的 `status`
 * 字面量（它恒为 `active`），于是账号列表里所有状态都渲染成「启用中」。
 */

/** 三态，与 `ops.operators.status` 的 CHECK 一致。 */
export const OPS_OPERATOR_STATUSES = ['invited', 'active', 'disabled'] as const;
export const opsOperatorStatusSchema = z.enum(OPS_OPERATOR_STATUSES);
export type OpsOperatorStatus = z.infer<typeof opsOperatorStatusSchema>;

/**
 * 账号上带的最小角色信息。
 *
 * 只给 `code` 与 `name`，不给 `id`：列表页要渲染角色名，不需要链接到角色详情；
 * 给了 `id` 就会有人拿它去拼 `PATCH /roles/{roleId}`，而那一跳需要 `role.manage`，
 * 账号管理页的读者通常没有。
 */
export const opsOperatorRoleRefSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
});
export type OpsOperatorRoleRef = z.infer<typeof opsOperatorRoleRefSchema>;

/**
 * 账号的对外形状 —— 列表项、PATCH 响应、邀请响应共用。
 *
 * `version` 与 `mfaRequired` 是 U-18 定稿的产物：`PATCH /operators/{id}` 要求
 * `version`，而本域没有 `GET /operators/{id}`，列表若不返回它，乐观锁的值无处可取。
 */
export const opsOperatorSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  displayName: z.string().nullable(),
  status: opsOperatorStatusSchema,
  mfaRequired: z.boolean(),
  version: z.number().int().positive(),
  roles: z.array(opsOperatorRoleRefSchema),
  lastLoginAt: z.string().nullable(),
});
export type OpsOperator = z.infer<typeof opsOperatorSchema>;

/** 排序白名单。首项即默认值（`createdAt` 降序 = 最新在前）。 */
export const OPS_OPERATOR_SORT_FIELDS = [
  'createdAt',
  'email',
  'displayName',
  'lastLoginAt',
] as const;

export const opsOperatorListQuerySchema = listQuerySchema(OPS_OPERATOR_SORT_FIELDS).extend({
  keyword: z.string().trim().max(120).optional(),
  status: opsOperatorStatusSchema.optional(),
  roleCode: z.string().trim().max(64).optional(),
});

export type OpsOperatorListQuery = z.infer<typeof opsOperatorListQuerySchema>;

export const opsOperatorListResponseSchema = pagedResponseSchema(opsOperatorSchema);
export type OpsOperatorListResponse = z.infer<typeof opsOperatorListResponseSchema>;

/**
 * 邀请。
 *
 * `roleCodes` 至少一个：邀请不带角色，等于造一个能登录但什么都做不了的账号，
 * 而那个账号第一次点菜单时的表现是「全空白」，排查方向会先落到权限配置上。
 * `reason` 必填不是流程仪式——`operator.manage` 是契约 §4 的高风险动作，
 * 审计里没有理由的那一条，事后没人能判断它是不是一次误操作。
 */
export const opsOperatorInvitationRequestSchema = z.object({
  email: z.string().trim().min(3).max(200),
  roleCodes: z.array(z.string().min(1)).min(1).max(20),
  reason: z.string().trim().min(1).max(500),
});
export type OpsOperatorInvitationRequest = z.infer<typeof opsOperatorInvitationRequestSchema>;

/**
 * 邀请响应只回 `{id,status}`。
 *
 * 契约 §5.1 的响应形状就是这两个字段——多回一份完整账号会诱使前端把它当成
 * 「已经拿到这条记录」直接塞进列表，而列表项还需要 `roles`（此刻刚写入）与
 * `version`（此刻是 1）。让前端在邀请成功后重拉一次列表，比让它猜哪些字段可信要省事。
 */
export const opsOperatorInvitationResponseSchema = z.object({
  operator: z.object({
    id: z.string().min(1),
    status: z.literal('invited'),
  }),
  /** 邀请链接的过期时间。由 GoTrue 的邮件配置决定，服务端按 24h 估算（见迁移注释）。 */
  invitationExpiresAt: z.string().min(1),
});
export type OpsOperatorInvitationResponse = z.infer<typeof opsOperatorInvitationResponseSchema>;

export const opsOperatorUpdateRequestSchema = z.object({
  status: opsOperatorStatusSchema.optional(),
  /**
   * 刻意**允许空数组**。
   *
   * 空数组是「把这个账号的角色清空」，而这是一条真实存在的不变量（LAST_ROLE）。
   * 在这里 `.min(1)` 会把它变成 400 VALIDATION_ERROR，于是前端拿到的是「参数不合法」
   * 而不是「至少要留一个角色」——两者的提示与后续动作都不同，后者能直接告诉人
   * 该先给谁什么角色。判定的权威在库里，接口只负责把话传过去。
   */
  roleCodes: z.array(z.string().min(1)).max(20).optional(),
  mfaRequired: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().positive(),
});
export type OpsOperatorUpdateRequest = z.infer<typeof opsOperatorUpdateRequestSchema>;

export const opsOperatorUpdateResponseSchema = z.object({
  operator: opsOperatorSchema,
  /**
   * 本次变更带来的权限增减（动作码差集）。
   *
   * 运营端用它做变更确认页的「这次改了什么」。让它算在服务端，是因为前端要算
   * 就得先拿全量角色-权限映射，而那份映射属于 `GET /roles`，账号管理页的读者
   * 不一定有权限读。
   */
  permissionsChanged: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
});
export type OpsOperatorUpdateResponse = z.infer<typeof opsOperatorUpdateResponseSchema>;

export const OPS_ROLE_STATUSES = ['active', 'disabled'] as const;
export const opsRoleStatusSchema = z.enum(OPS_ROLE_STATUSES);
export type OpsRoleStatus = z.infer<typeof opsRoleStatusSchema>;

export const opsRoleSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  /** U-22：可空字符串，不是 null。列表不返回它等于「能写不能读」。 */
  description: z.string(),
  isSystem: z.boolean(),
  status: opsRoleStatusSchema,
  permissions: z.array(z.string()),
});
export type OpsRole = z.infer<typeof opsRoleSchema>;

export const opsRoleListResponseSchema = z.object({
  items: z.array(opsRoleSchema),
});
export type OpsRoleListResponse = z.infer<typeof opsRoleListResponseSchema>;

/**
 * 角色码的形状约束。
 *
 * 只允许小写字母、数字与下划线，且以字母开头：角色码会出现在 `has_permission`
 * 的排查语句、日志与审计摘要里，允许任意字符串意味着允许空格、大写与中文，
 * 那会让「同一个角色」在两次比对之间长得不一样。
 */
export const OPS_ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export const opsRoleCreateRequestSchema = z.object({
  code: z.string().trim().regex(OPS_ROLE_CODE_PATTERN, 'code must match ^[a-z][a-z0-9_]{1,63}$'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  permissionCodes: z.array(z.string().min(1)).max(200).default([]),
  reason: z.string().trim().min(1).max(500),
});
export type OpsRoleCreateRequest = z.infer<typeof opsRoleCreateRequestSchema>;

export const opsRoleCreateResponseSchema = z.object({ role: opsRoleSchema });
export type OpsRoleCreateResponse = z.infer<typeof opsRoleCreateResponseSchema>;

/**
 * 角色编辑。**没有 `code`**：系统角色的 code 是权限映射的锚点（`platform_admin`
 * 拿满 39 个码靠的正是 code），改它等于把 seed 出来的映射指到空气上。让「改 code」
 * 在接口形状上不存在，比运行时判断 `isSystem` 更难被绕过。
 */
export const opsRoleUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  permissionCodes: z.array(z.string().min(1)).max(200).optional(),
  status: opsRoleStatusSchema.optional(),
  reason: z.string().trim().min(1).max(500),
});
export type OpsRoleUpdateRequest = z.infer<typeof opsRoleUpdateRequestSchema>;

export const opsRoleUpdateResponseSchema = z.object({
  role: opsRoleSchema,
  /** 变更前后的动作码集合。确认页要并排显示「加了几条、减了几条」。 */
  beforePermissions: z.array(z.string()),
  afterPermissions: z.array(z.string()),
});
export type OpsRoleUpdateResponse = z.infer<typeof opsRoleUpdateResponseSchema>;

/**
 * 审计事件的 actor。
 *
 * 可以为 null，且这不是疏忽：`ops.audit_events` 的两列 actor 在账号删除后置空
 * （`ON DELETE SET NULL`），service_role 与定时任务写入时两列本来就是空。
 * 用内连接过滤「没有 actor 的事件」会把这些行整段吞掉，而它们恰恰是「没人操作时
 * 系统做了什么」的唯一记录。
 */
export const opsAuditActorSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().nullable(),
  })
  .nullable();
export type OpsAuditActor = z.infer<typeof opsAuditActorSchema>;

export const opsAuditEventSchema = z.object({
  id: z.string().min(1),
  actor: opsAuditActorSchema,
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().nullable(),
  reason: z.string().nullable(),
  /**
   * 前后摘要的**形状由写入方决定**（`operator.updated` 是角色与权限，`role.created`
   * 是角色定义）。这里刻意用 `unknown`：把它写成一个具体形状，等于让某一类事件的
   * 摘要去约束全部事件，而审计表是所有域共用的。
   */
  beforeSummary: z.unknown(),
  afterSummary: z.unknown(),
  requestId: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type OpsAuditEvent = z.infer<typeof opsAuditEventSchema>;

/** 时间范围筛选。只校验「能被 Date 解析」，进一步格式交给 Postgres。 */
const timestampParamSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be an ISO 8601 timestamp',
  });

export const opsAuditEventListQuerySchema = listQuerySchema(['createdAt'] as const).extend({
  actorOperatorId: z.string().trim().min(1).optional(),
  action: z.string().trim().max(120).optional(),
  entityType: z.string().trim().max(80).optional(),
  entityId: z.string().trim().min(1).optional(),
  requestId: z.string().trim().max(120).optional(),
  from: timestampParamSchema.optional(),
  to: timestampParamSchema.optional(),
});
export type OpsAuditEventListQuery = z.infer<typeof opsAuditEventListQuerySchema>;

export const opsAuditEventListResponseSchema = pagedResponseSchema(opsAuditEventSchema);
export type OpsAuditEventListResponse = z.infer<typeof opsAuditEventListResponseSchema>;
