import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AuthContext } from './auth';

describe('AuthContext', () => {
  it('uses the shared identity, organization, session, and role fields', () => {
    const context: AuthContext = {
      userId: 'user-1',
      organizationId: 'organization-1',
      role: 'admin',
      sessionId: 'session-1',
      permissions: ['organization.read', 'member.manage', 'settings.manage', 'audit.read'],
      dataScope: 'all',
    };

    expect(context).toEqual({
      userId: 'user-1',
      organizationId: 'organization-1',
      role: 'admin',
      sessionId: 'session-1',
      permissions: ['organization.read', 'member.manage', 'settings.manage', 'audit.read'],
      dataScope: 'all',
    });
    expectTypeOf<AuthContext['role']>().toEqualTypeOf<'admin' | 'operator' | 'finance'>();
  });
});
