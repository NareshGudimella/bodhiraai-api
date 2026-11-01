/**
 * not in legacy (2026-11-01). `npm run db:direct-school`: the data step of
 * migration 0007 (`drizzle/0007_organizations.sql`, between the
 * "organizations data" markers), run again. It creates Bodhira Direct, the
 * default school, and moves the students with no school (and parents whose
 * children are all there) into it. The migration skips an empty database, so
 * run this after a data copy into one (cut-over) or after seeding.
 * Idempotent; prints how many users moved.
 */
process.env.TZ = 'UTC';

import { loadEnv } from '../config/env';
loadEnv();

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './db';

type Executor = Pick<Db, 'execute'>;

const MIGRATION = join(__dirname, '../../drizzle/0007_organizations.sql');

/** The migration's data statements, in order. */
export function directSchoolStatements(): string[] {
  const file = readFileSync(MIGRATION, 'utf8');
  const begin = file.indexOf('-- organizations data: begin');
  const end = file.indexOf('-- organizations data: end');
  if (begin < 0 || end < begin)
    throw new Error(`No data section in ${MIGRATION}`);
  return file
    .slice(begin, end)
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.replace(/^--.*$/gm, '').trim());
}

/** Runs the data step; returns the users moved per statement (students, parents). */
export async function applyDirectSchool(db: Executor) {
  const moved: number[] = [];
  for (const stmt of directSchoolStatements()) {
    const res = await db.execute(sql.raw(stmt));
    if (/^\s*(--.*\n\s*)*UPDATE/i.test(stmt)) moved.push(res.rowCount ?? 0);
  }
  return { students: moved[0] ?? 0, parents: moved[1] ?? 0 };
}

async function main() {
  const db = createDb();
  try {
    const { students, parents } = await applyDirectSchool(db);
    console.log(
      `Bodhira Direct: ${students} student(s) and ${parents} parent(s) moved.`,
    );
  } finally {
    await db.$client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
