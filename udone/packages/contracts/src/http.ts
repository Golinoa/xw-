import { z } from 'zod';

/**
 * HTTP 传输层约定。字段名、头名集中在这里，避免两端各写一遍字符串。
 */
export const ORGANIZATION_HEADER = 'X-Organization-ID';
export const REQUEST_ID_HEADER = 'X-Request-Id';
export const JSON_MEDIA_TYPE = 'application/json';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * 查询串里的布尔值。
 *
 * 🔴 不能用 `z.coerce.boolean()`：它走 `Boolean(value)`，而查询串里的值永远是**字符串**，
 * 于是 `'false'` 被解析成 `true`。表现是「取消勾选『含已取消』，已取消订单照样算进报表」、
 * 「关掉『只看未读』，列表还是只剩未读」——静默地把筛选条件反过来了。
 *
 * 只认 `'true' / 'false' / '1' / '0'`（以及真正的布尔），其余视为非法交给校验层报 400，
 * 而不是猜一个默认值。`ops/catalog.ts` 的 `isActive` 早就按这个口径写，这里是同一规则的复用。
 */
export const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['0', '1', 'false', 'true'])])
  .transform((value) => value === true || value === '1' || value === 'true');
