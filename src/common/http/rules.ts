/**
 * Shared limits and formats for input validation (see docs/input-limits.md).
 * security: not in legacy: everything here is stricter than legacy's rules.
 */

/** Phone: exactly 10 digits (Indian mobile; MSG91 adds the country code). Pair with a `max:`. */
export const PHONE_FORMAT = 'regex:/^[0-9]{10}$/';
export const PHONE_RE = /^[0-9]{10}$/;

/** A phone typed with +91 / 91, spaces or dashes, as the 10 digits stored (else unchanged). */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return value.trim();
}

/** Passwords: legacy had a minimum only. bcrypt ignores everything past 72 bytes. */
export const PASSWORD_MAX = 128;
/**
 * A new password: 6+ characters, with an uppercase and a lowercase letter, a digit and a
 * symbol (`password_strength`). Not for signing in: existing passwords keep working.
 */
export const PASSWORD_MIN = 6;
export const PASSWORD_RE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;
export const NEW_PASSWORD_RULES = [
  `min:${PASSWORD_MIN}`,
  `max:${PASSWORD_MAX}`,
  'password_strength',
];
/** The password a user types to sign in or confirm (existing accounts may hold longer ones). */
export const CURRENT_PASSWORD_MAX = 255;

/** Long text: lesson content, post and section bodies, JSON blobs. */
export const BODY_MAX = 100000;
/** Short descriptions (subjects, chapters, syllabi, plans, quizzes). */
export const DESCRIPTION_MAX = 1000;
/** URLs. */
export const URL_MAX = 2048;
/** Plausible calendar range for a stored date (dob uses its own lower bound). */
export const DATE_AFTER = 'after:2000-01-01';
export const DATE_BEFORE = 'before:2100-01-01';
/** Largest id list a reorder request may carry. */
export const IDS_MAX = 500;
/** Largest integer id. */
export const ID_MAX = 9007199254740991;
