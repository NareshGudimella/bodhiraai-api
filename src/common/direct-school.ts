import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { ApiException } from './http/api.exception';
import type { Db } from '../db/db';
import { schools } from '../db/schema';

/**
 * not in legacy: Bodhira Direct, the default school (2026-11-01). Self sign-up
 * students belong to it (`schools.is_direct`, migration 0007), but follow
 * exactly the rules legacy gave students with no school: the subscription
 * paywall, B2C checkout and invoices, content from their own syllabus, no seat
 * caps, no school-wide audiences. Code that means "the student's school" asks
 * `schoolOf()`, which answers null for Bodhira Direct; SQL uses
 * `individualSchool()` / `inDirectSchool()`.
 */
export const DIRECT_CODE = 'BODHIRA-DIRECT';

type Reader = Pick<Db, 'select'>;

// The direct school's id never changes once it exists (it can't be deleted).
const cache = new WeakMap<object, bigint>();

/** The id of Bodhira Direct, or null before it exists (an empty database). */
export async function directSchoolId(db: Reader): Promise<bigint | null> {
  const hit = cache.get(db);
  if (hit !== undefined) return hit;
  const [row] = await db
    .select({ id: schools.id })
    .from(schools)
    .where(sql`${schools.is_direct}`)
    .limit(1);
  if (row) cache.set(db, row.id);
  return row?.id ?? null;
}

/** The user's school for school rules: null without one, and null for Bodhira Direct. */
export async function schoolOf(
  db: Reader,
  user: { school_id: bigint | null },
): Promise<bigint | null> {
  if (user.school_id === null) return null;
  return user.school_id === (await directSchoolId(db)) ? null : user.school_id;
}

/**
 * SQL: `col` is Bodhira Direct's id. Plain names in the subquery: relational
 * queries re-alias interpolated columns to the outer table (docs/drizzle.md).
 */
export const inDirectSchool = (col: AnyColumn | SQL): SQL =>
  sql`${col} in (select "id" from "schools" where "is_direct")`;

/** SQL: no school, or Bodhira Direct (what `school_id IS NULL` meant before). */
export const individualSchool = (col: AnyColumn): SQL =>
  sql`(${col} is null or ${inDirectSchool(col)})`;

/**
 * 422 for what Bodhira Direct can't do: be deactivated or deleted, be billed
 * as a school, get seat caps or a School Admin. The Super Admin runs it.
 */
export function assertNotDirect(
  school: { is_direct: boolean } | null | undefined,
  what: string,
) {
  if (school?.is_direct) {
    throw new ApiException(
      `Bodhira Direct (the default school) can't ${what}.`,
      422,
      'direct_school',
    );
  }
}
