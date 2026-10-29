import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  type AuthContext,
  type PathParamNames,
  type Permission,
  type RouteResponse,
} from './index';

describe('contracts package entrypoint', () => {
  it('re-exports runtime constants and public types', () => {
    expect(ERROR_CODES.AUTH_REQUIRED).toBe('AUTH_REQUIRED');
    expect(PERMISSIONS.ORGANIZATION_READ).toBe('organization.read');
    expectTypeOf<AuthContext['role']>().toEqualTypeOf<'admin' | 'operator' | 'finance'>();
    expectTypeOf<Permission>().toEqualTypeOf<
      'organization.read' | 'member.manage' | 'settings.manage' | 'audit.read'
    >();
  });

  it('derives response types from the route registry instead of hand-written interfaces', () => {
    expectTypeOf<RouteResponse<'me'>>().toEqualTypeOf<{
      userId: string;
      memberships: {
        organizationId: string;
        organizationName: string;
        role: 'admin' | 'operator' | 'finance';
      }[];
    }>();
    expect(ROUTES.me.method).toBe('GET');
    expect(ROUTES.me.path).toBe('/api/me');
  });

  it('extracts path parameters from route templates', () => {
    expectTypeOf<PathParamNames<'/api/organizations/:id/members/:userId'>>().toEqualTypeOf<
      'id' | 'userId'
    >();
    expectTypeOf<PathParamNames<'/api/me'>>().toEqualTypeOf<never>();
  });

  it('registers every route with a unique method and path pair', () => {
    const pairs = Object.values(ROUTES).map((route) => `${route.method} ${route.path}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
