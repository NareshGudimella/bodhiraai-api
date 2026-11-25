import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Loads the project's `.env` (if present) into process.env with Node's built-in
 * parser. Resolved from this file so it works from src/, dist/ and Jest alike.
 * Real environment variables win over the file.
 */
export function loadEnv(path = resolve(__dirname, '../../.env')) {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] ??= value;
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const isDevelopment = () => process.env.NODE_ENV === 'development';

/**
 * security: not in legacy. How phone OTP sign-in (`/auth/otp/*`) delivers its
 * code: `sms` when MSG91 is configured and enabled (Integrations → SMS);
 * otherwise outside production `dev` (no SMS; development returns the code in
 * the response); in production `null`: the feature is off (503), since a code
 * could never reach its owner. Replaces OTP_LOGIN_ENABLED (2026-11-25).
 */
export function otpDelivery(
  smsActive: boolean,
  env = process.env,
): 'sms' | 'dev' | null {
  if (smsActive) return 'sms';
  return env.NODE_ENV === 'production' ? null : 'dev';
}
