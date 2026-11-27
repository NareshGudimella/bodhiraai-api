// Not in legacy (2026-11-27, docs/slug-contract.md): globally unique, stable URL slugs.
// The SQL twin (bodhira_slugify / bodhira_unique_slug, migration 0013) backfills old rows and
// fills rows inserted without a slug; keep the two in step.
import { eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../db/db';
import { strSlug } from '../storage/laravel-str';

export const SLUG_MAX = 80;

/** Entity word: prefix for an all-digit slug, fallback for an empty one. */
export const SLUG_WORD = {
  subject: 'subject',
  chapter: 'chapter',
  lesson: 'lesson',
  quiz: 'quiz',
  class: 'class',
  plan: 'plan',
  live: 'live-class',
  assignment: 'assignment',
} as const;

/** Slug of a title: `Str::slug`, cut near SLUG_MAX at a word boundary, never all digits, never empty. */
export function slugBase(title: string, word: string): string {
  let chars = Array.from(strSlug(title));
  if (chars.length > SLUG_MAX) {
    let cut = chars.slice(0, SLUG_MAX);
    if (chars[SLUG_MAX] !== '-' && cut.includes('-')) {
      cut = cut.slice(0, cut.lastIndexOf('-'));
    }
    chars = cut;
  }
  const base = chars.join('').replace(/^-+|-+$/g, '');
  if (!base) return word;
  return /^\d+$/.test(base) ? `${word}-${base}` : base;
}

/** First free `base`, `base-2`, `base-3`, … */
export async function firstFreeSlug(
  base: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!(await taken(slug))) return slug;
  }
}

type SlugDb = Pick<Db, 'select'>;

/** A free slug for `title` in `table.column` (citext: the check ignores case). */
export function uniqueSlug(
  db: SlugDb,
  table: PgTable,
  column: AnyPgColumn,
  title: string,
  word: string,
): Promise<string> {
  return firstFreeSlug(slugBase(title, word), async (slug) => {
    const rows = await db
      .select({ one: column })
      .from(table)
      .where(eq(column, slug))
      .limit(1);
    return rows.length > 0;
  });
}

function isUniqueViolation(e: unknown, depth = 0): boolean {
  const err = e as { code?: string; cause?: unknown } | null;
  if (err?.code === '23505') return true;
  return depth < 3 && !!err?.cause && isUniqueViolation(err.cause, depth + 1);
}

/**
 * Pick a free slug and run `insert(slug)`; a concurrent insert that took it first
 * (unique violation) just picks the next one. Not for use inside a transaction
 * (a violation aborts it).
 */
export async function insertWithSlug<T>(
  db: SlugDb,
  table: PgTable,
  column: AnyPgColumn,
  title: string,
  word: string,
  insert: (slug: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const slug = await uniqueSlug(db, table, column, title, word);
    try {
      return await insert(slug);
    } catch (e) {
      if (attempt >= 5 || !isUniqueViolation(e)) throw e;
    }
  }
}
