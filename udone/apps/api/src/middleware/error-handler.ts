import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorHandler } from 'hono';
import type { ApiErrorBody, ErrorCode } from '../../../../packages/contracts/src';
import { ERROR_CODES } from '../../../../packages/contracts/src';
import type { ApiEnvironment } from './auth';

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
