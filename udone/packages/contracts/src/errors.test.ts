import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from './errors';

describe('shared API errors', () => {
  it('exports the required error codes as a literal union', () => {
    expect(ERROR_CODES).toEqual({
      AUTH_REQUIRED: 'AUTH_REQUIRED',
      FORBIDDEN: 'FORBIDDEN',
      ORG_CONTEXT_REQUIRED: 'ORG_CONTEXT_REQUIRED',
      VALIDATION_ERROR: 'VALIDATION_ERROR',
      CONFLICT: 'CONFLICT',
      INTERNAL_ERROR: 'INTERNAL_ERROR',
    });
    expectTypeOf<ErrorCode>().toEqualTypeOf<
      | 'AUTH_REQUIRED'
      | 'FORBIDDEN'
      | 'ORG_CONTEXT_REQUIRED'
      | 'VALIDATION_ERROR'
      | 'CONFLICT'
      | 'INTERNAL_ERROR'
    >();
  });

  it('describes a stable error body with optional details', () => {
    const error: ApiErrorBody = {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Invalid input',
      requestId: 'request-1',
      details: { field: 'name' },
    };

    expect(error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Invalid input',
      requestId: 'request-1',
      details: { field: 'name' },
    });
    expectTypeOf<ApiErrorBody['code']>().toEqualTypeOf<string>();
    expectTypeOf<ApiErrorBody['details']>().toEqualTypeOf<unknown>();
  });
});
