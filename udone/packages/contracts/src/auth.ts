import type { AuthRole, DataScope, Permission } from './permissions';

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: AuthRole;
  sessionId: string;
  permissions: readonly Permission[];
  dataScope: DataScope;
}
