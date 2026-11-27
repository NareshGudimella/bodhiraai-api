import { createHmac, timingSafeEqual } from 'node:crypto';
import { derivedKey } from '../config/app-secret';
import { DEV_FILE_URL_SECRET } from '../storage/file-url';

/** Upload links are valid this long (seconds). */
export const UPLOAD_TTL = 2 * 3600;

export interface UploadGrant {
  lesson: string;
  user: string;
  filename: string;
  size: number;
  type: string;
  /** security: not in legacy: the lesson's state when the link was issued (`lessonVersion`). */
  ver: string;
  exp: number;
}

/**
 * security: not in legacy. Changes whenever the lesson is edited or its video replaced
 * (a successful PUT sets a new random `video_upload_key`), which ends every link issued
 * for the old state: a link works once and only on the lesson as it was.
 */
export const lessonVersion = (l: {
  updated_at: Date | null;
  video_upload_key: string | null;
  video_hls_path: string | null;
}) =>
  `${l.updated_at?.getTime() ?? ''}|${l.video_upload_key ?? ''}|${l.video_hls_path ?? ''}`;

const mac = (payload: string) =>
  createHmac('sha256', derivedKey('upload') ?? DEV_FILE_URL_SECRET)
    .update(payload)
    .digest('base64url');

/** not in legacy: `<base64url(JSON grant)>.<hmac>` (purpose `upload`), the only credential of the stream PUT. */
export function signUpload(
  g: Omit<UploadGrant, 'exp'>,
  now = Date.now(),
): { token: string; exp: number } {
  const exp = Math.floor(now / 1000) + UPLOAD_TTL;
  const payload = Buffer.from(JSON.stringify({ ...g, exp })).toString(
    'base64url',
  );
  return { token: `${payload}.${mac(payload)}`, exp };
}

/** The grant, or null when the token is forged, malformed or expired. */
export function verifyUpload(token: unknown, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [payload = '', sig = ''] = token.split('.');
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const g = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as UploadGrant;
    return g.exp * 1000 >= now ? g : null;
  } catch {
    return null;
  }
}

/** The API's own public origin: `https://api.` + the WEB_URL host in production, this API locally. */
export function apiOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.NODE_ENV === 'production')
    return `https://api.${new URL(env.WEB_URL ?? '').hostname}`;
  return (
    env.PUBLIC_URL?.trim() || `http://localhost:${env.PORT || 4000}`
  ).replace(/\/+$/, '');
}
