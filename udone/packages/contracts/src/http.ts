import type { ApiErrorBody } from './errors';

export type ApiResponse<T> = { success: true; data: T } | { success: false; error: ApiErrorBody };
