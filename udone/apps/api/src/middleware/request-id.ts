import type { MiddlewareHandler } from 'hono';
import type { ApiEnvironment } from './auth';

export const requestId = (): MiddlewareHandler<ApiEnvironment> => async (context, next) => {
  const suppliedId = context.req.header('X-Request-Id')?.trim();
  const id = suppliedId && suppliedId.length <= 128 ? suppliedId : crypto.randomUUID();

  context.set('requestId', id);
  context.header('X-Request-Id', id);
  await next();
};
