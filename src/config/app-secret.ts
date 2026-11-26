import { hkdfSync } from 'node:crypto';

/**
 * not in legacy: APP_SECRET is the one secret of the API, the worker and the web
 * app (32+ random bytes, base64 or hex: `openssl rand -base64 32`; the same value
 * everywhere). Each use gets its own key derived from it (HKDF-SHA256, info
 * `bodhira:<purpose>`), so no derived value reveals another or APP_SECRET:
 * - `settings`: AES-256-GCM key for the secrets saved in the admin panel;
 * - `file-urls`: HMAC key of signed private-file links (the edge Worker checks them);
 * - `proxy`: the X-Proxy-Secret the edge Worker and web server send;
 * - `video`: HMAC key of the lesson-video (HLS) playback tokens (API only).
 * The web app derives `proxy` and `file-urls` the same way (bodhiraai-ui
 * worker/app-secret.ts, src/lib/proxy-secret.ts). Changing APP_SECRET changes all
 * of them: set it everywhere at once and re-enter the panel's secrets.
 */
export type KeyPurpose = 'settings' | 'file-urls' | 'proxy' | 'video';

type Env = Record<string, string | undefined>;

export class AppSecretError extends Error {}

/** The raw APP_SECRET bytes, or null when unset. Throws when set but too short. */
export function appSecretBytes(env: Env = process.env): Buffer | null {
  const raw = env.APP_SECRET?.trim();
  if (!raw) return null;
  const bytes =
    /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
  if (bytes.length < 32)
    throw new AppSecretError(
      'APP_SECRET must be at least 32 bytes (openssl rand -base64 32).',
    );
  return bytes;
}

/**
 * The key for one purpose as 64 hex characters, or null when APP_SECRET is unset
 * outside production (callers then use their development defaults). Production
 * without APP_SECRET throws.
 */
export function derivedKey(
  purpose: KeyPurpose,
  env: Env = process.env,
): string | null {
  const master = appSecretBytes(env);
  if (!master) {
    if (env.NODE_ENV === 'production')
      throw new AppSecretError('APP_SECRET is not set.');
    return null;
  }
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.alloc(0), `bodhira:${purpose}`, 32),
  ).toString('hex');
}

/** Called at boot: production refuses to start without a usable APP_SECRET. */
export function assertAppSecret(env: Env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  if (!appSecretBytes(env))
    throw new AppSecretError('APP_SECRET must be set in production.');
}
