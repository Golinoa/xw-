/**
 * 运营后台契约包。
 *
 * 与业务端契约分开目录，理由同 `OPS_ROUTES` 与 `ROUTES` 分开：两套体系的
 * 错误码、鉴权来源、字段口径都不同。合在一个目录里，「这个 `customer.read`
 * 是运营的 39 码之一还是租户的角色权限」会变成需要看出处才能回答的问题——
 * 而两者恰好同名，是最容易串的一处。
 */
export * from './accounts';
export * from './audit-actions';
export * from './auth';
export * from './billing-shared';
export * from './catalog';
export * from './contracts';
export * from './customers';
export * from './deployment';
export * from './entitlements';
export * from './exports';
export * from './identity';
export * from './meta';
export * from './overview';
export * from './reports';
export * from './receipts';
export * from './receivables';
export * from './session';
export * from './settings';
export * from './tenant-integration';
export * from './tickets';
