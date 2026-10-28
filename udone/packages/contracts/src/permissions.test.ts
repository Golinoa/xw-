import { describe, expect, expectTypeOf, it } from 'vitest';
import { authorizationForRole, PERMISSIONS, type Permission } from './permissions';

describe('shared permissions', () => {
  it('exports the required permission constants and literal type', () => {
    expect(PERMISSIONS).toEqual({
      ORGANIZATION_READ: 'organization.read',
      MEMBER_MANAGE: 'member.manage',
      SETTINGS_MANAGE: 'settings.manage',
      AUDIT_READ: 'audit.read',
    });
    expectTypeOf<Permission>().toEqualTypeOf<
      'organization.read' | 'member.manage' | 'settings.manage' | 'audit.read'
    >();
  });

  it('assigns permissions and own/all data scope independently by organization role', () => {
    expect(authorizationForRole('admin')).toEqual({
      permissions: ['organization.read', 'member.manage', 'settings.manage', 'audit.read'],
      dataScope: 'all',
    });
    expect(authorizationForRole('operator')).toEqual({
      permissions: ['organization.read'],
      dataScope: 'own',
    });
    expect(authorizationForRole('finance')).toEqual({
      permissions: ['organization.read', 'audit.read'],
      dataScope: 'all',
    });
  });
});
