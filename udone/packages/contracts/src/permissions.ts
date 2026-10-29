import { z } from 'zod';

/**
 * 功能权限唯一真源。前端只用于展示控制，服务端与 RLS 各自强制。
 */
export const PERMISSIONS = {
  ORGANIZATION_READ: 'organization.read',
  MEMBER_MANAGE: 'member.manage',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_READ: 'audit.read',
  CUSTOMER_READ: 'customer.read',
  CUSTOMER_WRITE: 'customer.write',
  /** 查看客户电话、证件号原值；无此权限只返回掩码值。 */
  CUSTOMER_SENSITIVE_READ: 'customer.sensitive.read',
  ORDER_READ: 'order.read',
  ORDER_WRITE: 'order.write',
  SUPPLIER_READ: 'supplier.read',
  SUPPLIER_WRITE: 'supplier.write',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const permissionSchema = z.enum(Object.values(PERMISSIONS) as [Permission, ...Permission[]]);

export const DATA_SCOPES = ['own', 'all'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];
export const dataScopeSchema = z.enum(DATA_SCOPES);

export const ROLE_AUTHORIZATION = {
  admin: {
    permissions: [
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.MEMBER_MANAGE,
      PERMISSIONS.SETTINGS_MANAGE,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.CUSTOMER_READ,
      PERMISSIONS.CUSTOMER_WRITE,
      PERMISSIONS.CUSTOMER_SENSITIVE_READ,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_WRITE,
      PERMISSIONS.SUPPLIER_READ,
      PERMISSIONS.SUPPLIER_WRITE,
    ],
    dataScope: 'all',
  },
  operator: {
    permissions: [
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.CUSTOMER_READ,
      PERMISSIONS.CUSTOMER_WRITE,
      PERMISSIONS.CUSTOMER_SENSITIVE_READ,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_WRITE,
      PERMISSIONS.SUPPLIER_READ,
      PERMISSIONS.SUPPLIER_WRITE,
    ],
    dataScope: 'own',
  },
  finance: {
    permissions: [
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.CUSTOMER_READ,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.SUPPLIER_READ,
    ],
    dataScope: 'all',
  },
} as const satisfies Record<string, { permissions: readonly Permission[]; dataScope: DataScope }>;

export type AuthRole = keyof typeof ROLE_AUTHORIZATION;

/** 角色联合从权限矩阵派生，避免新增角色时漏改枚举。 */
export const authRoleSchema = z.enum(Object.keys(ROLE_AUTHORIZATION) as [AuthRole, ...AuthRole[]]);

export function authorizationForRole(role: AuthRole) {
  return ROLE_AUTHORIZATION[role];
}
