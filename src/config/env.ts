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

const TRUE = new Set(['1', 'true', 'yes', 'on']);

/**
 * security: not in legacy. Phone OTP sign-in (`/auth/otp/*`) is off in
 * production unless OTP_LOGIN_ENABLED is set to 1/true: no SMS provider is
 * wired, so a code could never reach its owner. Elsewhere it defaults to on
 * (development returns the code in the response); set 0/false to turn it off.
 */
export function otpLoginEnabled(env = process.env): boolean {
  const flag = env.OTP_LOGIN_ENABLED?.trim().toLowerCase();
  if (flag) return TRUE.has(flag);
  return env.NODE_ENV !== 'production';
}
