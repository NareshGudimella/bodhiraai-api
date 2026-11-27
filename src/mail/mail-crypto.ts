import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppSecretError, derivedKey } from '../config/app-secret';

// not in legacy: AES-256-GCM for the secrets stored in the database: the SMTP
// password in `mail_settings` and the provider secrets in `integration_settings`.
// Stored as `v1:<iv>.<tag>.<ciphertext>` (base64url). The key is derived from
// APP_SECRET (src/config/app-secret.ts, purpose `settings`).

const PREFIX = 'v1:';

/** Fixed key for development and tests only (APP_SECRET unset); production must set APP_SECRET. */
const DEV_KEY = Buffer.alloc(32, 'bodhira-dev-mail-settings-key');

export class MailKeyError extends Error {}

/** The 32-byte settings key from APP_SECRET (a development key outside production when unset). */
export function mailKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  try {
    const key = derivedKey('settings', env);
    return key ? Buffer.from(key, 'hex') : DEV_KEY;
  } catch (e) {
    throw new MailKeyError(e instanceof AppSecretError ? e.message : String(e));
  }
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
  const decipher = createDecipheriv('aes-256-gcm', mailKey(env), iv, {
    authTagLength: 16, // security: not in legacy: a shortened tag would weaken the forgery check
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}
