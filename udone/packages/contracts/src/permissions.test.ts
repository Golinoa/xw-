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
      ORDER_READ: 'order.read',
      ORDER_WRITE: 'order.write',
      SUPPLIER_READ: 'supplier.read',
      SUPPLIER_WRITE: 'supplier.write',
      FINANCE_WRITE: 'finance.write',
      FINANCE_APPROVE: 'finance.approve',
      CUSTOMER_RESTORE: 'customer.restore',
      ORDER_RESTORE: 'order.restore',
    });
    expectTypeOf<Permission>().toEqualTypeOf<
      | 'organization.read'
      | 'member.manage'
      | 'settings.manage'
      | 'audit.read'
      | 'customer.read'
      | 'customer.write'
      | 'customer.sensitive.read'
      | 'order.read'
      | 'order.write'
      | 'supplier.read'
      | 'supplier.write'
      | 'finance.write'
      | 'finance.approve'
      | 'customer.restore'
      | 'order.restore'
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
        'order.read',
        'order.write',
        'supplier.read',
        'supplier.write',
        'finance.write',
        'finance.approve',
        'customer.restore',
        'order.restore',
      ],
      dataScope: 'all',
    });
    // 计调员数据范围是 own：客户与订单在 API 与 RLS 两侧都会按本人创建过滤。
    expect(authorizationForRole('operator')).toEqual({
      permissions: [
        'organization.read',
        'customer.read',
        'customer.write',
        'customer.sensitive.read',
        'order.read',
        'order.write',
        'supplier.read',
        'supplier.write',
        'finance.write',
      ],
      dataScope: 'own',
    });
    // 财务负责收付款申请的创建与审批，但不改订单业务内容（REQUIREMENTS.md §16.3、R-FIN-02/03）。
    expect(authorizationForRole('finance')).toEqual({
      permissions: [
        'organization.read',
        'audit.read',
        'customer.read',
        'order.read',
        'supplier.read',
        'finance.write',
        'finance.approve',
      ],
      dataScope: 'all',
    });
  });
});
