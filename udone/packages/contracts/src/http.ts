/**
 * HTTP 传输层约定。字段名、头名集中在这里，避免两端各写一遍字符串。
 */
export const ORGANIZATION_HEADER = 'X-Organization-ID';
export const REQUEST_ID_HEADER = 'X-Request-Id';
export const JSON_MEDIA_TYPE = 'application/json';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
