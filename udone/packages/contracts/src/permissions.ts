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
  /**
   * 线路主数据。单独成权限而不是复用 `order.*`：线路是「公司口径」的主数据，
   * 与「能开一张订单」是两件事——只允许按既有线路开单、不允许新增线路的岗位是存在的。
   */
  ROUTE_READ: 'route.read',
  ROUTE_WRITE: 'route.write',
  /** 创建收付款申请（占用额度），不包含审批。 */
  FINANCE_WRITE: 'finance.write',
  /** 审批收付款申请；终审通过才计入已收/已付。 */
  FINANCE_APPROVE: 'finance.approve',
  /**
   * 恢复已删除的客户。这个权限同时决定「能否读到已删除行」——
   * 读已删除与能恢复是同一个能力，拆开只会多出一条没人用的读通道（B2）。
   */
  CUSTOMER_RESTORE: 'customer.restore',
  /** 恢复已删除的订单，语义同 CUSTOMER_RESTORE。 */
  ORDER_RESTORE: 'order.restore',
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
      PERMISSIONS.ROUTE_READ,
      PERMISSIONS.ROUTE_WRITE,
      PERMISSIONS.FINANCE_WRITE,
      PERMISSIONS.FINANCE_APPROVE,
      PERMISSIONS.CUSTOMER_RESTORE,
      PERMISSIONS.ORDER_RESTORE,
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
      PERMISSIONS.ROUTE_READ,
      PERMISSIONS.ROUTE_WRITE,
      PERMISSIONS.FINANCE_WRITE,
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
      PERMISSIONS.ROUTE_READ,
      PERMISSIONS.FINANCE_WRITE,
      PERMISSIONS.FINANCE_APPROVE,
    ],
    dataScope: 'all',
  },
} as const satisfies Record<string, { permissions: readonly Permission[]; dataScope: DataScope }>;

export type AuthRole = keyof typeof ROLE_AUTHORIZATION;

/** 角色联合从权限矩阵派生，避免新增角色时漏改枚举。 */
export const authRoleSchema = z.enum(Object.keys(ROLE_AUTHORIZATION) as [AuthRole, ...AuthRole[]]);

export interface RoleAuthorization {
  readonly permissions: readonly Permission[];
  readonly dataScope: DataScope;
}

/**
 * 角色的权限与数据范围。
 *
 * 返回类型必须显式写成 `readonly Permission[]`，不能让 `as const` 的字面量元组
 * 泄漏出去。泄漏之后调用处的 `role ? x.permissions : []` 会推出
 * 「三个只读元组 + never[]」的联合，`.includes(...)` 的参数类型取交集即 `never`，
 * 报出来的错是 `'order.read' is not assignable to 'never'`——和真实原因毫无关系，
 * 而且只有漏写 `computed<readonly Permission[]>` 标注的那个视图才会中招，
 * 于是这个坑会一个视图一个视图地重复踩。
 *
 * 矩阵本身仍然是 `as const satisfies`：字面量类型留在内部，用来保证每个角色
 * 列出的码都真实存在于 `Permission`。
 */
export function authorizationForRole(role: AuthRole): RoleAuthorization {
  return ROLE_AUTHORIZATION[role];
}
