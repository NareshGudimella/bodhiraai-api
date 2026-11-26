import { createHmac, timingSafeEqual } from 'node:crypto';
import { derivedKey } from '../config/app-secret';

/**
 * not in legacy: playback token of the self-hosted encrypted-HLS lesson video
 * (docs/video-hls-contract.md). A URL token, because native players cannot add
 * an Authorization header to playlist and key requests:
 * base64url(HMAC-SHA256(<video key>, "<lesson>\n<user>\n<exp unix s>")) plus the
 * data it covers, as `<user>.<exp>.<mac>` (the lesson comes from the route).
 */
export const HLS_TOKEN_TTL = 6 * 3600;

/** Development-only key, used outside production when APP_SECRET is unset. */
const DEV_KEY = 'bodhira-dev-video-token-key-not-for-production';

type Env = Record<string, string | undefined>;

const mac = (lesson: bigint | string, user: string, exp: number, env: Env) =>
  createHmac('sha256', derivedKey('video', env) ?? DEV_KEY)
    .update(`${lesson}\n${user}\n${exp}`)
    .digest('base64url');

export function signHlsToken(
  lesson: bigint | string,
  user: bigint | string,
  opts: { now?: number; env?: Env } = {},
): { token: string; exp: number } {
  const exp = Math.floor((opts.now ?? Date.now()) / 1000) + HLS_TOKEN_TTL;
  const env = opts.env ?? process.env;
  return {
    token: `${user}.${exp}.${mac(lesson, String(user), exp, env)}`,
    exp,
  };
}

/** The token's expiry when it is valid for this lesson and not expired (constant-time MAC compare), else null. */
export function verifyHlsToken(
  lesson: bigint | string,
  token: unknown,
  opts: { now?: number; env?: Env } = {},
): number | null {
  if (typeof token !== 'string') return null;
  const m = /^(\d{1,20})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const exp = Number(m[2]);
  if (exp < Math.floor((opts.now ?? Date.now()) / 1000)) return null;
  const want = Buffer.from(mac(lesson, m[1], exp, opts.env ?? process.env));
  const got = Buffer.from(m[3]);
  return got.length === want.length && timingSafeEqual(got, want) ? exp : null;
}
