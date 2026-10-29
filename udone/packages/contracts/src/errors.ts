import { z } from 'zod';

/**
 * 全站错误码唯一真源。新增错误码只能改这里，前端按 code 映射文案，不解析 message。
 */
export const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  /** 请求带了组织上下文，但调用者不属于该组织或该组织不是当前会话组织。 */
  TENANT_SCOPE_DENIED: 'TENANT_SCOPE_DENIED',
  ORG_CONTEXT_REQUIRED: 'ORG_CONTEXT_REQUIRED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  /** 主数据仍被业务单据引用，不能物理删除（需求 §19.2）。 */
  OBJECT_REFERENCED: 'OBJECT_REFERENCED',
  /** 订单当前状态不允许该动作，例如对已锁团订单执行确认出团。 */
  ORDER_STATE_CONFLICT: 'ORDER_STATE_CONFLICT',
  /** 订单金额行已经发生收付款，不能从编辑请求里删除。 */
  ORDER_LINE_HAS_PAYMENTS: 'ORDER_LINE_HAS_PAYMENTS',
  /** 金额行的新金额低于已确认 + 在途，会让可申请余额变成负数。 */
  ORDER_LINE_AMOUNT_CONFLICT: 'ORDER_LINE_AMOUNT_CONFLICT',
  /** 申请金额超过该明细行的可申请余额（已扣掉在途）。 */
  FINANCE_AMOUNT_EXCEEDS_AVAILABLE: 'FINANCE_AMOUNT_EXCEEDS_AVAILABLE',
  /** 申请已经不在待审状态，或者审批级次与当前进度不符。 */
  FINANCE_APPLICATION_STATE_CONFLICT: 'FINANCE_APPLICATION_STATE_CONFLICT',
  /** 创建人不能审批自己提交的申请（当前固定禁止，不做开关）。 */
  FINANCE_SELF_APPROVAL_FORBIDDEN: 'FINANCE_SELF_APPROVAL_FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const errorCodeSchema = z.enum(Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

/** 失败响应体：扁平结构，不套 success 包装层。 */
export const apiErrorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  requestId: z.string(),
  details: z.unknown().optional(),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
