import { z } from 'zod';
import { listQuerySchema, pagedResponseSchema } from './pagination';

/** CRM 线索与公海（R-CRM-01/02）。阶段转换与认领的版本号必须原样回传，服务端做乐观锁。 */
export const LEAD_STAGES = ['new', 'contacting', 'quoting', 'proposal', 'won', 'lost'] as const;
export const leadStageSchema = z.enum(LEAD_STAGES);
export type LeadStage = z.infer<typeof leadStageSchema>;

export const LEAD_SORT_FIELDS = ['createdAt', 'stage', 'nextFollowUpAt'] as const;

export const leadSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  phone: z.string().nullable(),
  wechat: z.string().nullable(),
  email: z.string().nullable(),
  source: z.string().nullable(),
  destination: z.string().nullable(),
  departureCity: z.string().nullable(),
  tripType: z.string().nullable(),
  intentLevel: z.string().nullable(),
  expectedDate: z.string().nullable(),
  budgetMin: z.number().nullable(),
  budgetMax: z.number().nullable(),
  adultCount: z.number().int().min(0),
  childCount: z.number().int().min(0),
  remark: z.string().nullable(),
  stage: leadStageSchema,
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  nextFollowUpAt: z.string().nullable(),
  lastFollowUpAt: z.string().nullable(),
  convertedCustomerId: z.string().nullable(),
  /** 已转出的订单；空表示还没开单。前端据此决定「转订单」按钮是否可点。 */
  convertedOrderId: z.string().nullable().optional(),
  version: z.number().int().min(1),
  createdAt: z.string(),
});
export type Lead = z.infer<typeof leadSchema>;

export const leadListQuerySchema = listQuerySchema(LEAD_SORT_FIELDS).extend({
  stage: leadStageSchema.optional(),
  ownerId: z.string().optional(),
  inPool: z.coerce.boolean().default(false),
});
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const leadListResponseSchema = pagedResponseSchema(leadSchema);
export type LeadListResponse = z.infer<typeof leadListResponseSchema>;

export const leadEventSchema = z.object({
  id: z.string().min(1),
  eventType: z.string(),
  detail: z.string().nullable(),
  actorName: z.string(),
  createdAt: z.string(),
});

export const leadDetailResponseSchema = leadSchema.extend({
  events: z.array(leadEventSchema),
});
export type LeadDetailResponse = z.infer<typeof leadDetailResponseSchema>;

export const createLeadRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  phone: z.string().trim().min(1).max(40),
  wechat: z.string().trim().max(60).optional(),
  email: z.string().trim().email().optional(),
  source: z.string().trim().min(1).max(60),
  destination: z.string().trim().min(1).max(80),
  departureCity: z.string().trim().min(1).max(80),
  tripType: z.string().trim().min(1).max(40),
  intentLevel: z.string().trim().min(1).max(40),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  budgetMin: z.number().min(0),
  budgetMax: z.number().min(0),
  adultCount: z.number().int().min(0).default(0),
  childCount: z.number().int().min(0).default(0),
  remark: z.string().trim().max(500).optional(),
});
export type CreateLeadRequest = z.infer<typeof createLeadRequestSchema>;

export const createLeadResponseSchema = z.object({ leadId: z.string().min(1) });
export type CreateLeadResponse = z.infer<typeof createLeadResponseSchema>;

export const followUpLeadRequestSchema = z.object({
  leadId: z.string().min(1),
  stage: leadStageSchema,
  detail: z.string().trim().min(1).max(500),
  nextFollowUpAt: z.string().datetime().optional(),
});
export type FollowUpLeadRequest = z.infer<typeof followUpLeadRequestSchema>;

export const leadActionRequestSchema = z.object({
  leadId: z.string().min(1),
  version: z.number().int().min(1),
  ownerId: z.string().uuid().optional(),
});
export type LeadActionRequest = z.infer<typeof leadActionRequestSchema>;

export const convertLeadResponseSchema = z.object({ customerId: z.string().min(1) });
export type ConvertLeadResponse = z.infer<typeof convertLeadResponseSchema>;

/**
 * 线索转订单。
 *
 * 口径（与数据库函数一致，写在这里防止前端自己发明）：
 * - 只有 `won` 的线索能转；未成单就开单等于绕过漏斗。
 * - 转出来的是**预订单**，金额留空——线索里只有预算区间，那是意向不是应收。
 * - 幂等：`version` 只用来挡并发，重复调用返回同一张订单，不会建第二张。
 */
export const convertLeadToOrderRequestSchema = z.object({
  leadId: z.string().min(1),
  version: z.number().int().min(1),
  remark: z.string().trim().max(500).optional(),
});
export type ConvertLeadToOrderRequest = z.infer<typeof convertLeadToOrderRequestSchema>;

export const convertLeadToOrderResponseSchema = z.object({ orderId: z.string().min(1) });
export type ConvertLeadToOrderResponse = z.infer<typeof convertLeadToOrderResponseSchema>;

/** 阶段统计按「区间内新建的线索 + 当前所处阶段」，不按历史到达复算。 */
export const leadFunnelQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
});
export type LeadFunnelQuery = z.infer<typeof leadFunnelQuerySchema>;

export const leadFunnelResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  total: z.number().int().min(0),
  stages: z.record(z.string(), z.number().int().min(0)),
  convertedCustomers: z.number().int().min(0),
  convertedOrders: z.number().int().min(0),
});
export type LeadFunnelResponse = z.infer<typeof leadFunnelResponseSchema>;
