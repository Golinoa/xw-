import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from './errors';

describe('shared API errors', () => {
  it('exports the required error codes as a literal union', () => {
    expect(ERROR_CODES).toEqual({
      AUTH_REQUIRED: 'AUTH_REQUIRED',
      FORBIDDEN: 'FORBIDDEN',
      TENANT_SCOPE_DENIED: 'TENANT_SCOPE_DENIED',
      ORG_CONTEXT_REQUIRED: 'ORG_CONTEXT_REQUIRED',
      VALIDATION_ERROR: 'VALIDATION_ERROR',
      NOT_FOUND: 'NOT_FOUND',
      CONFLICT: 'CONFLICT',
      OBJECT_REFERENCED: 'OBJECT_REFERENCED',
      ORDER_STATE_CONFLICT: 'ORDER_STATE_CONFLICT',
      ORDER_LINE_HAS_PAYMENTS: 'ORDER_LINE_HAS_PAYMENTS',
      ORDER_LINE_AMOUNT_CONFLICT: 'ORDER_LINE_AMOUNT_CONFLICT',
      FINANCE_AMOUNT_EXCEEDS_AVAILABLE: 'FINANCE_AMOUNT_EXCEEDS_AVAILABLE',
      FINANCE_APPLICATION_STATE_CONFLICT: 'FINANCE_APPLICATION_STATE_CONFLICT',
      FINANCE_SELF_APPROVAL_FORBIDDEN: 'FINANCE_SELF_APPROVAL_FORBIDDEN',
      IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
      RATE_LIMITED: 'RATE_LIMITED',
      INTERNAL_ERROR: 'INTERNAL_ERROR',
    });
    expectTypeOf<ErrorCode>().toEqualTypeOf<
      | 'AUTH_REQUIRED'
      | 'FORBIDDEN'
      | 'TENANT_SCOPE_DENIED'
      | 'ORG_CONTEXT_REQUIRED'
      | 'VALIDATION_ERROR'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'OBJECT_REFERENCED'
      | 'ORDER_STATE_CONFLICT'
      | 'ORDER_LINE_HAS_PAYMENTS'
      | 'ORDER_LINE_AMOUNT_CONFLICT'
      | 'FINANCE_AMOUNT_EXCEEDS_AVAILABLE'
      | 'FINANCE_APPLICATION_STATE_CONFLICT'
      | 'FINANCE_SELF_APPROVAL_FORBIDDEN'
      | 'IDEMPOTENCY_CONFLICT'
      | 'RATE_LIMITED'
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
