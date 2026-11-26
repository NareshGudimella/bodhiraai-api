import { derivedKey } from '../config/app-secret';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * security: not in legacy. Short-lived signed links for private files
 * (contract: protected media, 2026-11-01).
 *
 * The database stores private files as the relative value `/files/<key>`.
 * Responses turn that into
 *
 *     <site>/files/<key>?exp=<unix seconds>&sig=<sig>
 *
 * with sig = base64url(HMAC-SHA256(<file-urls key>, "<key>\n<exp>")). The
 * edge Worker (production) and this API (local, see files.handler.ts) check it.
 *
 * The key is derived from APP_SECRET (purpose `file-urls`; the edge Worker's
 * file-link key is the same value, derived from APP_SECRET there).
 * Fail closed: in production the API refuses to start without APP_SECRET
 * (assertFileUrlConfig in main.ts), and fileUrlSecret() throws as well, so
 * nothing is ever signed with the development default.
 */

/** Value prefix of a private file in the database. */
export const FILES_PREFIX = '/files/';

/** Development-only secret, used outside production when APP_SECRET is unset. */
export const DEV_FILE_URL_SECRET =
  'bodhira-dev-file-url-secret-not-for-production';

/** The server rejects links that expire more than 24 h ahead. */
export const MAX_AHEAD = 86_400;

type Env = Record<string, string | undefined>;

const isProduction = (env: Env) => env.NODE_ENV === 'production';

/** The HMAC key. Throws in production when APP_SECRET is missing or short. */
export function fileUrlSecret(env: Env = process.env): string {
  return derivedKey('file-urls', env) ?? DEV_FILE_URL_SECRET;
}

/** Called at boot: in production, refuse to start without a usable secret and base URL. */
export function assertFileUrlConfig(env: Env = process.env) {
  if (!isProduction(env)) return;
  fileUrlSecret(env);
  if (!env.WEB_URL?.trim())
    throw new Error('WEB_URL must be set in production');
}

/** Link lifetime in seconds. */
export const FILE_URL_TTL = 1800;

/**
 * Origin the signed links point at (no trailing slash): the site (WEB_URL) in
 * production, where the edge Worker serves /files/*; this API locally
 * (files.handler.ts; PUBLIC_URL is a test override).
 */
export function filesBaseUrl(env: Env = process.env): string {
  const base = isProduction(env)
    ? (env.WEB_URL ?? '')
    : env.PUBLIC_URL?.trim() || `http://localhost:${env.PORT || 4000}`;
  return base.trim().replace(/\/+$/, '');
}

/**
 * Keys that are never signed and never served: invoices (served only by the
 * API with an ownership check), `..`, backslashes, empty segments, a leading
 * `/`, and control characters.
 */
export function isForbiddenKey(key: string): boolean {
  if (!key || key.startsWith('/')) return true;
  if (key.toLowerCase().startsWith('invoices/')) return true;
  if (key.includes('..') || key.includes('\\')) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) return true;
  return key.split('/').some((segment) => segment === '');
}

/** Each `/`-separated segment percent-encoded. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** Inverse of encodeKey; null for malformed percent-encoding. */
export function decodeKey(path: string): string | null {
  try {
    return path.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

function hmac(key: string, exp: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${key}\n${exp}`)
    .digest('base64url');
}

/** `<base>/files/<key>?exp&sig`. Throws for a forbidden key. */
export function signFileKey(
  key: string,
  opts: { now?: number; ttl?: number; env?: Env } = {},
): string {
  if (isForbiddenKey(key)) throw new Error('This file key cannot be signed');
  const env = opts.env ?? process.env;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const exp = now + (opts.ttl ?? FILE_URL_TTL);
  const sig = hmac(key, exp, fileUrlSecret(env));
  return `${filesBaseUrl(env)}${FILES_PREFIX}${encodeKey(key)}?exp=${exp}&sig=${sig}`;
}

export type VerifyResult = { ok: true; exp: number } | { ok: false };

/**
 * Check a decoded key with its `exp` and `sig` query values: well-formed,
 * not forbidden, a matching signature (constant-time), and, unless
 * `ignoreExpiry`, not expired and at most 24 h ahead.
 */
export function verifyFileSignature(
  key: string,
  exp: unknown,
  sig: unknown,
  opts: { now?: number; env?: Env; ignoreExpiry?: boolean } = {},
): VerifyResult {
  if (typeof exp !== 'string' || typeof sig !== 'string') return { ok: false };
  if (!/^\d{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig))
    return { ok: false };
  if (isForbiddenKey(key)) return { ok: false };
  const expiry = Number(exp);
  if (!opts.ignoreExpiry) {
    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    if (expiry < now || expiry > now + MAX_AHEAD) return { ok: false };
  }
  const expected = Buffer.from(
    hmac(key, expiry, fileUrlSecret(opts.env ?? process.env)),
  );
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false };
  return { ok: true, exp: expiry };
}

/** The key of a stored `/files/<key>` value, or null for anything else. */
export function fileKeyOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(FILES_PREFIX)) return null;
  const key = value.slice(FILES_PREFIX.length);
  return isForbiddenKey(key) ? null : key;
}

/**
 * Response side: a stored private-column value as clients get it. `/files/<key>`
 * becomes a signed link; anything else (external links, legacy `/media/…` or
 * `/cloud/…` URLs, null) is returned unchanged. A forbidden key is returned
 * unsigned (unusable) rather than signed.
 */
export function signedFileUrl<T>(value: T): T | string {
  const key = fileKeyOf(value);
  return key === null ? value : signFileKey(key);
}

export class ForgedFileUrl extends Error {}

/**
 * Request side, for private columns a client may send back (an edit form
 * re-submitting `content_url`): our own signed link is verified and stored as
 * `/files/<key>`. The expiry is not checked (a form may sit open longer than
 * the TTL), the signature is. A link to our `/files/` path with a missing or
 * wrong signature, or a bare `/files/…` value, throws ForgedFileUrl. Other
 * values pass through.
 */
export function unsignFileUrl<T>(value: T, env: Env = process.env): T | string {
  if (typeof value !== 'string') return value;
  if (value.startsWith(FILES_PREFIX)) throw new ForgedFileUrl();
  const base = `${filesBaseUrl(env)}${FILES_PREFIX}`;
  if (!value.toLowerCase().startsWith(base.toLowerCase())) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgedFileUrl();
  }
  const prefix = new URL(base).pathname;
  const key = url.pathname.startsWith(prefix)
    ? decodeKey(url.pathname.slice(prefix.length))
    : null;
  if (
    key === null ||
    !verifyFileSignature(
      key,
      url.searchParams.get('exp') ?? undefined,
      url.searchParams.get('sig') ?? undefined,
      { env, ignoreExpiry: true },
    ).ok
  ) {
    throw new ForgedFileUrl();
  }
  return `${FILES_PREFIX}${key}`;
}
