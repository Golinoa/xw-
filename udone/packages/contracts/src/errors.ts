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
  /**
   * 运营端通用状态机冲突（契约 §6.3）。
   *
   * 不复用 `ORDER_STATE_CONFLICT`：那个码属于租户侧订单状态机，前端按它渲染的
   * 文案与后续动作都不同。两个域共用一个码，症状是运营端把「不能移除最后一个
   * 管理员」显示成「订单状态不允许该操作」。
   */
  STATE_CONFLICT: 'STATE_CONFLICT',
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
  /**
   * 同一订单内已有相同「证件类型 + 证件号」的游客。
   *
   * 不复用通用 `CONFLICT`：这个名字要出现在导入结果的逐行错误里，而
   * 「数据已被他人修改」对着一份要改的 CSV 完全没有指导意义。
   */
  TOURIST_DOCUMENT_CONFLICT: 'TOURIST_DOCUMENT_CONFLICT',
  /** 创建人不能审批自己提交的申请（当前固定禁止，不做开关）。 */
  FINANCE_SELF_APPROVAL_FORBIDDEN: 'FINANCE_SELF_APPROVAL_FORBIDDEN',
  /**
   * 结算金额超过这条应付明细还能结的额度（应付金额 − 已确认结算）。
   *
   * 不复用 `FINANCE_AMOUNT_EXCEEDS_AVAILABLE`：那个码的文案是「可申请余额（已扣在途）」，
   * 而结算看的是累计已结算金额，两者不是同一个数。混用会让用户盯着错误的数字改金额。
   */
  SETTLEMENT_AMOUNT_EXCEEDS_AVAILABLE: 'SETTLEMENT_AMOUNT_EXCEEDS_AVAILABLE',
  /** 结算批次已确认或已作废，不能再确认 / 作废。 */
  SETTLEMENT_STATE_CONFLICT: 'SETTLEMENT_STATE_CONFLICT',
  /**
   * 同一个 Idempotency-Key 被用于了不一样的内容。
   *
   * 与通用 `CONFLICT` 分开是为了让调用方能区分「业务对象状态冲突」与
   * 「幂等键被复用」：后者是客户端 bug，重试永远不会成功，必须换 key。
   */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /**
   * 租户命令同步目标不可达/超时，结果未知（契约 §6.3，502）。
   *
   * details 固定带 `commandId` 与 `retryable`。命令本身仍以 pending 落库，
   * 运营侧不能把它显示成失败——那会让用户重试出一个重复命令。
   */
  SYNC_TARGET_UNAVAILABLE: 'SYNC_TARGET_UNAVAILABLE',
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
