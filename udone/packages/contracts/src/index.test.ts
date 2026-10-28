import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ERROR_CODES,
  PERMISSIONS,
  type ApiResponse,
  type AuthContext,
  type Permission,
} from './index';

describe('contracts package entrypoint', () => {
  it('re-exports runtime constants and public types', () => {
    expect(ERROR_CODES.AUTH_REQUIRED).toBe('AUTH_REQUIRED');
    expect(PERMISSIONS.ORGANIZATION_READ).toBe('organization.read');
    expectTypeOf<AuthContext['role']>().toEqualTypeOf<'admin' | 'operator' | 'finance'>();
    expectTypeOf<Permission>().toEqualTypeOf<
      'organization.read' | 'member.manage' | 'settings.manage' | 'audit.read'
    >();
    expectTypeOf<
      Extract<ApiResponse<string>, { success: false }>['error']['code']
    >().toEqualTypeOf<string>();
  });
});
