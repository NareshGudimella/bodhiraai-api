import {
  asc,
  Column,
  desc,
  getTableColumns,
  getTableName,
  is,
  sql,
  type AnyColumn,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * Helpers that keep legacy's query behaviour on PostgreSQL. Use them instead
 * of the bare drizzle-orm functions where the difference shows.
 */

/**
 * ORDER BY … ASC with legacy's NULL placement (NULLs first). PostgreSQL puts
 * them last, so a bare asc() reorders rows on nullable columns.
 */
export const myAsc = (col: AnyColumn | SQLWrapper) =>
  sql`${col} asc nulls first`;

/** ORDER BY … DESC with legacy's NULL placement (NULLs last). */
export const myDesc = (col: AnyColumn | SQLWrapper) =>
  sql`${col} desc nulls last`;

/** Plain asc()/desc(), for NOT NULL columns (ids, timestamps that are always set). */
export { asc, desc };

/**
 * `LIKE '%term%'` as legacy searched (case-insensitive,
 * with %, _ and \ in the term matched literally).
 */
export function containsCi(col: AnyColumn | SQLWrapper, term: string): SQL {
  return sql`${col} ilike ${'%' + escapeLike(term) + '%'}`;
}

/** `LIKE 'term%'`, case-insensitive, as legacy searched. */
export function startsWithCi(col: AnyColumn | SQLWrapper, term: string): SQL {
  return sql`${col} ilike ${escapeLike(term) + '%'}`;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/**
 * A correlated COUNT(*) of child rows, standing in for Prisma's `_count`.
 * Use it in relational queries' `extras` with the callback's (aliased) column:
 *
 *   extras: (t) => ({
 *     students_count: countOf(class_student, 'class_id', t.id).as('students_count'),
 *   })
 *
 * Inside `extras`, Drizzle re-aliases every column reference to the parent
 * table, so the child table is written out by name here (alias `c`). Extra
 * conditions on the child rows use `c(column)`:
 *   countOf(attendance, 'class_id', t.id, (c) => sql`${c('status')} = 'present'`)
 */
export function countOf(
  child: PgTable,
  fk: string,
  parent: AnyColumn | SQLWrapper,
  where?: (c: (column: string) => SQL) => SQL,
) {
  const c = (column: string) =>
    sql`${sql.identifier('c')}.${sql.identifier(column)}`;
  const extra = where ? sql` and ${where(c)}` : sql``;
  // Top-level relational queries render their own columns unqualified ("id"),
  // which inside this subquery would mean c.id. Qualify with the table or alias.
  const outer = is(parent, Column)
    ? sql`${sql.identifier(getTableName(parent.table))}.${sql.identifier(parent.name)}`
    : parent;
  return sql<number>`(select count(*) from ${sql.identifier(getTableName(child))} as ${sql.identifier('c')} where ${c(fk)} = ${outer}${extra})`.mapWith(
    Number,
  );
}

/**
 * AVG() as legacy returned it for integer columns: rounded to 4 decimals.
 * PostgreSQL returns full precision. Null for no rows.
 */
export const myAvg = (col: AnyColumn | SQLWrapper) =>
  sql<number | null>`round(avg(${col}), 4)`.mapWith((v) =>
    v === null ? null : Number(v),
  );

/** SUM() as a number (null for no rows, as legacy returned it). */
export const mySum = (col: AnyColumn | SQLWrapper) =>
  sql<number | null>`sum(${col})`.mapWith((v) =>
    v === null ? null : Number(v),
  );

/** Every table by its name, for code that picks the table at runtime (validator rules, CMS resources). */
export const TABLES: Record<string, PgTable> = Object.fromEntries(
  Object.entries(schema).filter(
    ([, v]) =>
      v && typeof v === 'object' && Symbol.for('drizzle:IsDrizzleTable') in v,
  ),
) as Record<string, PgTable>;

/** A table by name, or a thrown error naming it. */
export function tableNamed(name: string): PgTable {
  const t = TABLES[name];
  if (!t) throw new Error(`Unknown table: ${name}`);
  return t;
}

/** A column of a runtime-chosen table by name. */
export function columnNamed(table: PgTable, name: string): AnyColumn {
  const col = (getTableColumns(table) as Record<string, AnyColumn>)[name];
  if (!col) throw new Error(`Unknown column: ${name}`);
  return col;
}

/** The first row or null (Prisma's findFirst on a core select). */
export const firstOrNull = <T>(rows: T[]): T | null => rows[0] ?? null;
