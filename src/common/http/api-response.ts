/**
 * Response envelope, identical to the legacy App\Support\ApiResponse so the
 * mobile app and web can switch backends without client changes.
 *
 *   success: { success: true,  message, data, meta? }
 *   error:   { success: false, message, code?, errors? }
 */
export interface ApiSuccess<T> {
  success: true;
  message: string | null;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  success: false;
  message: string;
  code?: string;
  errors?: unknown;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
}

export function ok<T>(
  data: T,
  message: string | null = null,
  meta?: Record<string, unknown>,
): ApiSuccess<T> {
  return meta
    ? { success: true, message, data, meta }
    : { success: true, message, data };
}

/** Mirrors Laravel's LengthAwarePaginator envelope (`data` + `meta`). */
export function paginated<T>(
  p: Paginated<T>,
  message: string | null = null,
  meta: Record<string, unknown> = {},
): ApiSuccess<T[]> {
  return ok(p.items, message, {
    current_page: p.page,
    per_page: p.perPage,
    total: p.total,
    last_page: Math.max(1, Math.ceil(p.total / p.perPage)),
    ...meta,
  });
}

export function fail(
  message: string,
  code?: string,
  errors?: unknown,
): ApiError {
  const payload: ApiError = { success: false, message };
  if (code) payload.code = code;
  if (errors !== undefined) payload.errors = errors;
  return payload;
}
