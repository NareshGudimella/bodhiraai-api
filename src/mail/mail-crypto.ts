import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// not in legacy: AES-256-GCM for the SMTP password stored in `mail_settings`.
// Stored as `v1:<iv>.<tag>.<ciphertext>` (base64url). The key is MAIL_SETTINGS_KEY:
// 32 bytes as 64 hex characters or base64 (`openssl rand -base64 32`).

const PREFIX = 'v1:';

/** Fixed key for development and tests only; production must set MAIL_SETTINGS_KEY. */
const DEV_KEY = Buffer.alloc(32, 'bodhira-dev-mail-settings-key');

export class MailKeyError extends Error {}

/** The 32-byte key from MAIL_SETTINGS_KEY (a development key outside production when unset). */
export function mailKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.MAIL_SETTINGS_KEY?.trim();
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new MailKeyError('MAIL_SETTINGS_KEY is not set.');
    }
    return DEV_KEY;
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new MailKeyError(
      'MAIL_SETTINGS_KEY must be 32 bytes (64 hex characters or base64).',
    );
  }
  return key;
}

export function encryptSecret(
  plain: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mailKey(env), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return (
    PREFIX +
    [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString('base64url'))
      .join('.')
  );
}

/** Throws when the value is malformed, tampered with, or the key is wrong. */
export function decryptSecret(
  stored: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!stored.startsWith(PREFIX)) throw new Error('Unsupported secret format.');
  const [iv, tag, data] = stored
    .slice(PREFIX.length)
    .split('.')
    .map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Malformed secret.');
  const decipher = createDecipheriv('aes-256-gcm', mailKey(env), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}
