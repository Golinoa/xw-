import { describe, expect, expectTypeOf, it } from 'vitest';
import { authorizationForRole, PERMISSIONS, type Permission } from './permissions';

describe('shared permissions', () => {
  it('exports the required permission constants and literal type', () => {
    expect(PERMISSIONS).toEqual({
      ORGANIZATION_READ: 'organization.read',
      MEMBER_MANAGE: 'member.manage',
      SETTINGS_MANAGE: 'settings.manage',
      AUDIT_READ: 'audit.read',
      CUSTOMER_READ: 'customer.read',
      CUSTOMER_WRITE: 'customer.write',
      CUSTOMER_SENSITIVE_READ: 'customer.sensitive.read',
    });
    expectTypeOf<Permission>().toEqualTypeOf<
      | 'organization.read'
      | 'member.manage'
      | 'settings.manage'
      | 'audit.read'
      | 'customer.read'
      | 'customer.write'
      | 'customer.sensitive.read'
    >();
  });

  it('assigns permissions and own/all data scope independently by organization role', () => {
    expect(authorizationForRole('admin')).toEqual({
      permissions: [
        'organization.read',
        'member.manage',
        'settings.manage',
        'audit.read',
        'customer.read',
        'customer.write',
        'customer.sensitive.read',
      ],
      dataScope: 'all',
    });
    // 计调员数据范围是 own：客户列表在 API 与 RLS 两侧都会按本人创建过滤。
    expect(authorizationForRole('operator')).toEqual({
      permissions: [
        'organization.read',
        'customer.read',
        'customer.write',
        'customer.sensitive.read',
      ],
      dataScope: 'own',
    });
    // 财务只读客户，且看不到电话/证件原值（REQUIREMENTS.md §16.3）。
    expect(authorizationForRole('finance')).toEqual({
      permissions: ['organization.read', 'audit.read', 'customer.read'],
      dataScope: 'all',
    });
  });
});
