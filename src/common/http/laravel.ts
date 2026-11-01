import { signedFileUrl } from '../../storage/file-url';
import { ApiException } from './api.exception';

/**
 * Helpers that reproduce Laravel's serialisation and errors exactly, so ported
 * endpoints stay byte-compatible with the legacy API.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Carbon::toIso8601String() → `2026-06-02T12:23:18+00:00` (process TZ is UTC). */
export function iso8601(d: Date | null | undefined): string | null {
  return d ? d.toISOString().replace(/\.\d{3}Z$/, '+00:00') : null;
}

/** Eloquent model serialisation of cast dates → `2026-06-02T12:23:18.000000Z`. */
export function eloquentDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') : null;
}

/** Uncast DATETIME/TIMESTAMP column as Eloquent returns it → `2026-06-02 12:23:18`. */
export function rawDateTime(d: Date | null | undefined): string | null {
  if (!d) return null;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** `Y-m-d` in UTC. */
export function dateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * PHP json_encode() with default flags, as Laravel's `array` cast writes JSON
 * columns: escapes "/" as "\/" and non-ASCII as \uXXXX (UTF-16 units).
 * Use for every JSON column written to the shared DB so rows stay byte-identical.
 */
export function phpJsonEncode(value: unknown): string {
  const json = JSON.stringify(value).replace(/\//g, '\\/');
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code > 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : json[i];
  }
  return out;
}

/**
 * PHP json_decode($json, true) as a value that phpJsonEncode() writes back the
 * way PHP would: objects become arrays, so `{}` and `{"0":…,"1":…}` re-encode
 * as lists. Invalid JSON is null.
 */
export function phpJsonDecode(json: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const assoc = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(assoc);
    if (!v || typeof v !== 'object') return v;
    const entries = Object.entries(v).map(([k, x]) => [k, assoc(x)] as const);
    return entries.every(([k], i) => k === String(i))
      ? entries.map(([, x]) => x)
      : Object.fromEntries(entries);
  };
  return assoc(value);
}

/** Two `array` cast values are equal when they decode to the same thing (Laravel's originalIsEquivalent). */
export function sameJson(original: string | null, encoded: string) {
  if (original === null) return false;
  return phpJsonEncode(phpJsonDecode(original)) === encoded;
}

/** `$request->boolean($key)`: filter_var(FILTER_VALIDATE_BOOLEAN) on the input. */
export function requestBoolean(v: unknown): boolean {
  return (
    v === true ||
    v === 1 ||
    (typeof v === 'string' &&
      ['1', 'true', 'on', 'yes'].includes(v.trim().toLowerCase()))
  );
}

/** A scalar request value as a string (anything else is ''). */
export function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (
    typeof v === 'number' ||
    typeof v === 'bigint' ||
    typeof v === 'boolean'
  ) {
    return String(v);
  }
  return '';
}

/** `$request->filled($key)`: present and not a blank string. */
export function requestFilled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean' || typeof v === 'object') return true;
  return toStr(v).trim() !== '';
}

/** PHP number_format($n, $decimals) with the default "." and "," separators. */
export function numberFormat(n: number, decimals = 0): string {
  const f = 10 ** decimals;
  const rounded = Math.sign(n) * (Math.round(Math.abs(n) * f + 1e-9) / f);
  const [int, frac] = Math.abs(rounded).toFixed(decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${rounded < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** JSON column (stored as LONGTEXT) with an `array` cast. */
export function jsonCast<T = unknown>(
  raw: string | null | undefined,
): T | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Carbon::diffForHumans() relative to now, default options (one unit, truncated),
 * e.g. "3 minutes ago", "4 months ago", "1 week from now".
 */
export function diffForHumans(
  d: Date | null | undefined,
  now = new Date(),
): string | null {
  if (!d) return null;
  const future = d.getTime() > now.getTime();
  const [a, b] = future ? [now, d] : [d, now];
  const sec = Math.floor((b.getTime() - a.getTime()) / 1000);

  let months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth());
  const anchor = new Date(a);
  anchor.setUTCMonth(a.getUTCMonth() + months);
  if (anchor.getTime() > b.getTime()) months -= 1;

  let value: number;
  let unit: string;
  if (months >= 12) [value, unit] = [Math.floor(months / 12), 'year'];
  else if (months >= 1) [value, unit] = [months, 'month'];
  else if (sec >= 7 * 86400)
    [value, unit] = [Math.floor(sec / (7 * 86400)), 'week'];
  else if (sec >= 86400) [value, unit] = [Math.floor(sec / 86400), 'day'];
  else if (sec >= 3600) [value, unit] = [Math.floor(sec / 3600), 'hour'];
  else if (sec >= 60) [value, unit] = [Math.floor(sec / 60), 'minute'];
  else [value, unit] = [Math.max(sec, 1), 'second'];

  return `${value} ${unit}${value === 1 ? '' : 's'} ${future ? 'from now' : 'ago'}`;
}

/** PHP round(): half away from zero. */
export function phpRound(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** Route-model binding miss: `No query results for model [App\Models\Subject] 99`. */
export function modelNotFound(
  model: string,
  id: string | number | bigint,
): ApiException {
  return new ApiException(
    `No query results for model [App\\Models\\${model}] ${String(id)}`,
    404,
  );
}

/** Parse a route id like Laravel binding does (non-numeric ids simply don't match). */
export function routeId(raw: string, model: string): bigint {
  if (!/^\d+$/.test(raw)) throw modelNotFound(model, raw);
  return BigInt(raw);
}

/**
 * `file` (security: not in legacy): a private-file column; `/files/<key>`
 * values come out as short-lived signed links (storage/file-url.ts).
 */
type Cast = 'datetime' | 'date' | 'array' | 'bool' | 'int' | 'file';

/**
 * Eloquent Model::toArray() for a database row: hides `$hidden`, applies `$casts`,
 * and leaves uncast columns the way PDO returns them (tinyint → 0/1, DATETIME →
 * "Y-m-d H:i:s", DATE → "Y-m-d"). created_at/updated_at/deleted_at are always dates.
 */
export function eloquentRow(
  row: Record<string, unknown>,
  opts: {
    casts?: Readonly<Record<string, Cast>>;
    hidden?: readonly string[];
    dateOnly?: readonly string[];
  } = {},
): Record<string, unknown> {
  const casts: Record<string, Cast> = {
    created_at: 'datetime',
    updated_at: 'datetime',
    deleted_at: 'datetime',
    ...opts.casts,
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (opts.hidden?.includes(key)) continue;
    // Relation results (objects/arrays) are not columns; `select *` never returns them.
    if (
      Array.isArray(value) ||
      (value && typeof value === 'object' && !(value instanceof Date))
    ) {
      continue;
    }
    const cast = casts[key];
    if (cast === 'datetime' || cast === 'date')
      out[key] = eloquentDate(value as Date | null);
    else if (cast === 'array') out[key] = jsonCast(value as string | null);
    else if (cast === 'bool') out[key] = Boolean(value);
    else if (cast === 'int') out[key] = value === null ? null : Number(value);
    else if (cast === 'file') out[key] = signedFileUrl(value);
    else if (value instanceof Date) {
      out[key] = opts.dateOnly?.includes(key)
        ? dateString(value)
        : rawDateTime(value);
    } else if (typeof value === 'boolean') out[key] = value ? 1 : 0;
    else out[key] = value;
  }
  return out;
}

/** Formats PHP's date parser accepts that clients actually send. */
const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse like Carbon::parse. Returns the real instant (for `after:now`) and the
 * wall-clock value Eloquent stores: it formats the parsed time as Y-m-d H:i:s
 * in the *input's* offset, dropping the offset itself.
 */
export function parseLaravelDate(
  value: string,
): { instant: Date; stored: Date } | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', tz] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const check = new Date(wall);
  if (
    check.getUTCMonth() !== +mo - 1 ||
    check.getUTCDate() !== +d ||
    +h > 23 ||
    +mi > 59 ||
    +s > 59
  ) {
    return null;
  }
  let offsetMin = 0;
  if (tz && tz !== 'Z') {
    const sign = tz.startsWith('-') ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    offsetMin = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2));
  }
  return {
    instant: new Date(wall - offsetMin * 60_000),
    stored: new Date(wall),
  };
}

/** `firstOrFail()` with no id: `No query results for model [Illuminate\Notifications\DatabaseNotification].` */
export function modelNotFoundClass(fqcn: string): ApiException {
  return new ApiException(`No query results for model [${fqcn}].`, 404);
}

/** Bare `abort(403)`: Laravel renders an empty message as "HTTP error" (bootstrap/app.php). */
export const forbidden = () => new ApiException('HTTP error', 403);
