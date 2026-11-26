import { createHmac, timingSafeEqual } from 'node:crypto';
import { derivedKey } from '../config/app-secret';

/**
 * not in legacy: playback token of the self-hosted encrypted-HLS lesson video
 * (docs/video-hls-contract.md). A URL token, because native players cannot add
 * an Authorization header to playlist and key requests:
 * base64url(HMAC-SHA256(<video key>, "<session>\n<lesson>\n<user>\n<exp unix s>")) plus
 * the data it covers, as `<session>.<user>.<exp>.<mac>` (the lesson comes from
 * the route). Strict playback protection: the session row decides whether it
 * still works (video_sessions); `exp` is the session's `segments_until`.
 */
const DEV_KEY = 'bodhira-dev-video-token-key-not-for-production';

type Env = Record<string, string | undefined>;

const mac = (
  session: string,
  lesson: bigint | string,
  user: string,
  exp: number,
  env: Env,
) =>
  createHmac('sha256', derivedKey('video', env) ?? DEV_KEY)
    .update(`${session}\n${lesson}\n${user}\n${exp}`)
    .digest('base64url');

export function signHlsToken(
  session: string,
  lesson: bigint | string,
  user: bigint | string,
  exp: number,
  env: Env = process.env,
): string {
  return `${session}.${user}.${exp}.${mac(session, lesson, String(user), exp, env)}`;
}

/** The token's session, user and expiry when valid for this lesson and not expired (constant-time MAC compare), else null. */
export function verifyHlsToken(
  lesson: bigint | string,
  token: unknown,
  opts: { now?: number; env?: Env } = {},
): { session: string; user: bigint; exp: number } | null {
  if (typeof token !== 'string') return null;
  const m =
    /^([0-9a-f]{32})\.(\d{1,20})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const exp = Number(m[3]);
  if (exp < Math.floor((opts.now ?? Date.now()) / 1000)) return null;
  const want = Buffer.from(
    mac(m[1], lesson, m[2], exp, opts.env ?? process.env),
  );
  const got = Buffer.from(m[4]);
  return got.length === want.length && timingSafeEqual(got, want)
    ? { session: m[1], user: BigInt(m[2]), exp }
    : null;
}
