import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorHandler } from 'hono';
import type { ApiErrorBody, ErrorCode } from '@erp/contracts';
import { ERROR_CODES } from '@erp/contracts';
import type { ApiEnvironment } from './auth';
import { RestMissingResourceError } from '../lib/rest-client';

export class ApiHttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export const errorHandler: ErrorHandler<ApiEnvironment> = (error, context) => {
  const requestId = context.get('requestId') ?? crypto.randomUUID();

  /**
   * 缺表/缺函数（多半是迁移没应用）单独报出来。
   *
   * 对客户端仍然是 500 + 通用文案：调用方拿不到内部结构；但**服务端日志**必须写出
   * 缺的是哪个 `rpc/xxx`，否则这一类故障只能靠人工比对迁移清单。
   * `details.dependency` 也带出去，方便看日志的人一步定位。
   */
  if (error instanceof RestMissingResourceError) {
    console.error(`[dependency-missing] requestId=${requestId} resource=${error.resource}`);
    context.header('X-Request-Id', requestId);
    return context.json(
      {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'A required backend resource is missing',
        requestId,
        details: { dependency: error.resource },
      },
      500,
    );
  }

  const isApiError = error instanceof ApiHttpError;
  const body: ApiErrorBody = {
    code: isApiError ? error.code : ERROR_CODES.INTERNAL_ERROR,
    message: isApiError ? error.message : 'An unexpected error occurred',
    requestId,
    ...(isApiError && error.details !== undefined ? { details: error.details } : {}),
  };

  context.header('X-Request-Id', requestId);
  return context.json(body, isApiError ? error.status : 500);
};
