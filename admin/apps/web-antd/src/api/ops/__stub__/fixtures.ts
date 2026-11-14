/**
 * 开发态契约桩的虚构数据。
 *
 * 全部为虚构内容：邮箱统一使用保留域名 `example.invalid`（RFC 2606，永不投递），
 * 名称带「（虚构）」后缀，金额为演示用整数。禁止写入任何真实客户、联系人或金额。
 */
import type {
  OpsMeta,
  OpsPermissionCatalog,
  OpsSession,
} from '../identity/session';

import { OPS_PERMISSION_CODES } from '#/constants/permissions';

/** 后端当前实现的契约版本；桩固定为一个明显的非真实值，便于一眼识别。 */
export const STUB_CONTRACT_VERSION = '1.0.0-stub';

export const STUB_OPERATOR = {
  displayName: '开发桩·演示运营（虚构）',
  email: 'stub.operator@example.invalid',
  id: '00000000-0000-4000-8000-000000000001',
  mfaRequired: false,
  status: 'active',
} as const;

export const STUB_SESSION: OpsSession = {
  lastLoginAt: '2026-10-29T02:00:00Z',
  operator: STUB_OPERATOR,
  permissionVersion: 1,
  // 桩授予全部已登记动作码，便于在没有后端时走通全部页面；
  // 需要验证"无权限"分支时改成子集即可。
  permissions: [...OPS_PERMISSION_CODES],
  roles: [{ code: 'ops_demo_admin', name: '运营演示管理员（虚构）' }],
};

export const STUB_META: OpsMeta = {
  contractVersion: STUB_CONTRACT_VERSION,
  serverTime: '2026-10-29T02:00:00Z',
  supportedCurrencies: ['CNY'],
  supportedSalesModes: ['saas', 'private'],
  timezone: 'Asia/Shanghai',
};

export const STUB_PERMISSION_CATALOG: OpsPermissionCatalog = {
  items: OPS_PERMISSION_CODES.map((code) => ({
    code,
    description: '开发态契约桩条目（虚构）',
    domain: code.split('.')[0] ?? 'unknown',
    isHighRisk: false,
  })),
};

/** 桩登录账号，避免开发者误以为任意口令都能登录。 */
export const STUB_CREDENTIALS = {
  password: 'stub',
  username: 'stub',
} as const;
