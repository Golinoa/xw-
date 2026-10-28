export const PERMISSIONS = {
  ORGANIZATION_READ: 'organization.read',
  MEMBER_MANAGE: 'member.manage',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_READ: 'audit.read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export type DataScope = 'own' | 'all';

export const ROLE_AUTHORIZATION = {
  admin: {
    permissions: [PERMISSIONS.ORGANIZATION_READ, PERMISSIONS.MEMBER_MANAGE, PERMISSIONS.SETTINGS_MANAGE, PERMISSIONS.AUDIT_READ],
    dataScope: 'all',
  },
  operator: { permissions: [PERMISSIONS.ORGANIZATION_READ], dataScope: 'own' },
  finance: { permissions: [PERMISSIONS.ORGANIZATION_READ, PERMISSIONS.AUDIT_READ], dataScope: 'all' },
} as const satisfies Record<string, { permissions: readonly Permission[]; dataScope: DataScope }>;

export type AuthRole = keyof typeof ROLE_AUTHORIZATION;

export function authorizationForRole(role: AuthRole) {
  return ROLE_AUTHORIZATION[role];
}
