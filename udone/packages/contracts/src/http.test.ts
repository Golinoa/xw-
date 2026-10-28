import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ApiErrorBody } from './errors';
import type { ApiResponse } from './http';

describe('ApiResponse', () => {
  it('discriminates success data from the shared error body', () => {
    const success: ApiResponse<{ id: string }> = {
      success: true,
      data: { id: 'item-1' },
    };
    const failure: ApiResponse<{ id: string }> = {
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
        requestId: 'request-1',
      },
    };

    expect(success).toEqual({ success: true, data: { id: 'item-1' } });
    expect(failure).toEqual({
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
        requestId: 'request-1',
      },
    });
    expectTypeOf<
      Extract<ApiResponse<{ id: string }>, { success: false }>['error']
    >().toEqualTypeOf<ApiErrorBody>();
  });
});
