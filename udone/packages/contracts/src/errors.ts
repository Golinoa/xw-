import { z } from 'zod';

/**
 * 全站错误码唯一真源。新增错误码只能改这里，前端按 code 映射文案，不解析 message。
 */
export const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  ORG_CONTEXT_REQUIRED: 'ORG_CONTEXT_REQUIRED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
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
