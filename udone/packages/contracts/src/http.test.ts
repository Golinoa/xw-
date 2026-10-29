import { describe, expect, it } from 'vitest';
import { apiErrorBodySchema, ERROR_CODES } from './errors';
import { JSON_MEDIA_TYPE, ORGANIZATION_HEADER, REQUEST_ID_HEADER } from './http';

describe('HTTP transport contract', () => {
  it('keeps header and media-type names in one place', () => {
    expect(ORGANIZATION_HEADER).toBe('X-Organization-ID');
    expect(REQUEST_ID_HEADER).toBe('X-Request-Id');
    expect(JSON_MEDIA_TYPE).toBe('application/json');
  });

  it('accepts the flat error body and rejects the abandoned envelope shape', () => {
    const flat = {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'The request body is invalid',
      requestId: 'request-1',
    };
    expect(apiErrorBodySchema.parse(flat)).toEqual(flat);

    const abandonedEnvelope = {
      success: false,
      error: flat,
    };
    expect(apiErrorBodySchema.safeParse(abandonedEnvelope).success).toBe(false);
  });

  it('rejects unknown error codes so new codes must be declared first', () => {
    const result = apiErrorBodySchema.safeParse({
      code: 'SOMETHING_NEW',
      message: 'x',
      requestId: 'request-1',
    });
    expect(result.success).toBe(false);
  });
});
