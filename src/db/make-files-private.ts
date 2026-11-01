/**
 * security: not in legacy. Cut-over script `npm run files:make-private`
 * (contract: protected media, 2026-11-01).
 *
 * Moves files referenced by private columns out of the public buckets into the
 * private bucket and rewrites each value to `/files/<key>`; uploaded lesson
 * videos are imported into VdoCipher instead (importUrl with a presigned link
 * to the source object) and get `video_id`, with `content_url` cleared.
 *
 *   npm run files:make-private                      dry run: prints the plan, writes nothing
 *   npm run files:make-private -- --apply           copy, rewrite, import
 *   npm run files:make-private -- --apply --delete-source
 *                                                   also delete the moved source objects
 *
 * Sources a value can point at:
 *   <R2_PUBLIC_URL or /uploads base>/<key>  this API's public uploads (R2_BUCKET / LOCAL_UPLOAD_DIR)
 *   /media/<path>, <LEGACY_FILES_ORIGIN>/media/<path>
 *                                           legacy uploads, copied to R2_LEGACY_BUCKET under
 *                                           media/<path> (runbook §3); the private key is <path>
 *   /cloud/<path>, <LEGACY_FILES_ORIGIN>/cloud/<path>
 *                                           legacy cloud images, R2_LEGACY_BUCKET cloud/<path>
 * Locally (STORAGE_DRIVER=local) legacy files are read from LEGACY_FILES_DIR
 * (a copy laid out like the legacy bucket). Anything else (external links) is
 * left alone. Invoices are never moved here.
 *
 * Re-runnable: `/files/` values and lessons with a video_id are skipped. A row
 * is rewritten only if its value is unchanged since it was read. With
 * --delete-source, a source object is deleted only when every row that
 * referenced it was rewritten, and never for a video handed to VdoCipher (it
 * fetches the source later; delete those once the videos are ready). Without VDOCIPHER_API_SECRET, lesson videos are
 * moved to the private bucket like other files.
 *
 * In production (NODE_ENV=production) --apply also needs --confirm-production.
 */
process.env.TZ = 'UTC';

import { loadEnv } from '../config/env';
loadEnv();

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { FILES_PREFIX, isForbiddenKey, signFileKey } from '../storage/file-url';
import { createR2Client, StorageService } from '../storage/storage.service';
import { VdoCipherClient } from '../video/vdocipher.client';
import { createDb, type Db } from './db';
import * as schema from './schema';

type Column =
  | 'users.avatar'
  | 'schools.logo'
  | 'lessons.content_url'
  | 'lessons.thumbnail'
  | 'assignments.attachment_url'
  | 'assignment_submissions.file_url'
  | 'live_classes.recording_url';

/** Where an object lives: a bucket (r2) or a directory (local). */
interface Location {
  store: string;
  key: string;
}

interface Source extends Location {
  /** Key in the private bucket. */
  dest: string;
}

interface Row {
  column: Column;
  id: bigint;
  value: string;
  /** lessons.type, for the video import. */
  type?: string;
  /** lessons.title, as the VdoCipher video title. */
  title?: string;
}

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const DELETE_SOURCE = args.has('--delete-source');
const r2 = process.env.STORAGE_DRIVER === 'r2';
let s3: S3Client | null = null;
const client = () => (s3 ??= createR2Client());

const log = (...parts: unknown[]) => console.log(...parts);

function publicBase(): string {
  return new StorageService().publicBase;
}

/** Private-bucket key for a stored value, with where to copy it from; null when it isn't ours. */
export function sourceOf(value: string, env = process.env): Source | null {
  if (value.startsWith(FILES_PREFIX)) return null;
  const base = publicBase();
  if (base && value.startsWith(`${base}/`)) {
    const key = decodeURIComponent(value.slice(base.length + 1).split('?')[0]);
    return {
      store: r2 ? (env.R2_BUCKET ?? '') : StorageService.localDir(),
      key,
      dest: key,
    };
  }
  let path = value;
  const legacyOrigin = env.LEGACY_FILES_ORIGIN?.replace(/\/+$/, '');
  if (legacyOrigin && path.startsWith(`${legacyOrigin}/`))
    path = path.slice(legacyOrigin.length);
  const m = /^\/(media|cloud)\/(.+)$/.exec(path.split('?')[0]);
  if (!m) return null;
  const rest = decodeURIComponent(m[2]);
  const legacyStore = r2
    ? (env.R2_LEGACY_BUCKET ?? 'bodhira-legacy')
    : env.LEGACY_FILES_DIR
      ? resolve(env.LEGACY_FILES_DIR)
      : '';
  return {
    store: legacyStore,
    key: `${m[1]}/${rest}`,
    // /media/<path> was served from the public disk root; /cloud/ keeps its prefix.
    dest: m[1] === 'media' ? rest : `cloud/${rest}`,
  };
}

function localPath(dir: string, key: string): string | null {
  const root = resolve(dir);
  const path = resolve(root, key);
  return path.startsWith(`${root}${sep}`) ? path : null;
}

async function exists(loc: Location): Promise<boolean> {
  if (!loc.store) return false;
  if (r2) {
    try {
      await client().send(
        new HeadObjectCommand({ Bucket: loc.store, Key: loc.key }),
      );
      return true;
    } catch {
      return false;
    }
  }
  const path = localPath(loc.store, loc.key);
  return !!path && !!(await stat(path).catch(() => null))?.isFile();
}

function privateStore(): string {
  if (!r2) return StorageService.privateDir();
  const bucket = process.env.R2_PRIVATE_BUCKET;
  if (!bucket) throw new Error('R2_PRIVATE_BUCKET is not set');
  return bucket;
}

async function copyToPrivate(src: Source) {
  const dest = { store: privateStore(), key: src.dest };
  if (await exists(dest)) return;
  if (r2) {
    await client().send(
      new CopyObjectCommand({
        Bucket: dest.store,
        Key: dest.key,
        CopySource: `${src.store}/${src.key.split('/').map(encodeURIComponent).join('/')}`,
        MetadataDirective: 'COPY',
      }),
    );
  } else {
    const from = localPath(src.store, src.key);
    const to = localPath(dest.store, dest.key);
    if (!from || !to) throw new Error(`Unsafe path ${src.key}`);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  if (!(await exists(dest))) throw new Error(`Copy of ${src.key} not found`);
}

async function deleteObject(loc: Location) {
  if (r2) {
    await client().send(
      new DeleteObjectCommand({ Bucket: loc.store, Key: loc.key }),
    );
    return;
  }
  const path = localPath(loc.store, loc.key);
  if (path) await unlink(path);
}

/** A link VdoCipher can fetch the source from (6 h). */
async function importLink(src: Source): Promise<string> {
  if (r2)
    return getSignedUrl(
      client(),
      new GetObjectCommand({ Bucket: src.store, Key: src.key }),
      { expiresIn: 6 * 3600 },
    );
  // Local: copy it privately first and hand out a signed /files/ link.
  await copyToPrivate(src);
  return signFileKey(src.dest, { ttl: 6 * 3600 });
}

async function readRows(db: Db): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (column: Column, list: { id: bigint; v: string | null }[]) => {
    for (const r of list) if (r.v) rows.push({ column, id: r.id, value: r.v });
  };
  const { users, schools, lessons, assignments, assignment_submissions } =
    schema;
  const lc = schema.live_classes;
  add(
    'users.avatar',
    await db
      .select({ id: users.id, v: users.avatar })
      .from(users)
      .where(isNotNull(users.avatar))
      .orderBy(users.id),
  );
  add(
    'schools.logo',
    await db
      .select({ id: schools.id, v: schools.logo })
      .from(schools)
      .where(isNotNull(schools.logo))
      .orderBy(schools.id),
  );
  for (const l of await db
    .select({
      id: lessons.id,
      v: lessons.content_url,
      type: lessons.type,
      title: lessons.title,
    })
    .from(lessons)
    .where(and(isNotNull(lessons.content_url), isNull(lessons.video_id)))
    .orderBy(lessons.id)) {
    if (l.v)
      rows.push({
        column: 'lessons.content_url',
        id: l.id,
        value: l.v,
        type: l.type,
        title: l.title,
      });
  }
  add(
    'lessons.thumbnail',
    await db
      .select({ id: lessons.id, v: lessons.thumbnail })
      .from(lessons)
      .where(isNotNull(lessons.thumbnail))
      .orderBy(lessons.id),
  );
  add(
    'assignments.attachment_url',
    await db
      .select({ id: assignments.id, v: assignments.attachment_url })
      .from(assignments)
      .where(isNotNull(assignments.attachment_url))
      .orderBy(assignments.id),
  );
  add(
    'assignment_submissions.file_url',
    await db
      .select({
        id: assignment_submissions.id,
        v: assignment_submissions.file_url,
      })
      .from(assignment_submissions)
      .where(isNotNull(assignment_submissions.file_url))
      .orderBy(assignment_submissions.id),
  );
  add(
    'live_classes.recording_url',
    await db
      .select({ id: lc.id, v: lc.recording_url })
      .from(lc)
      .where(isNotNull(lc.recording_url))
      .orderBy(lc.id),
  );
  return rows;
}

/** Rewrite one row if its value hasn't changed since it was read. */
async function rewrite(db: Db, row: Row, set: Record<string, unknown>) {
  const [table, column] = row.column.split('.') as [
    keyof typeof schema,
    string,
  ];
  const t = schema[table] as unknown as typeof schema.users;
  const col = (t as unknown as Record<string, typeof schema.users.avatar>)[
    column
  ];
  const res = await db
    .update(t)
    .set(set)
    .where(and(eq(t.id, row.id), eq(col, row.value)));
  return (res.rowCount ?? 0) > 0;
}

async function main() {
  if (
    APPLY &&
    process.env.NODE_ENV === 'production' &&
    !args.has('--confirm-production')
  ) {
    throw new Error(
      'Refusing --apply in production without --confirm-production',
    );
  }
  const db = createDb();
  const vdo = new VdoCipherClient();
  const useVdo = vdo.configured();
  log(
    `files:make-private (${APPLY ? 'APPLY' : 'dry run'}${DELETE_SOURCE ? ', delete sources' : ''}; storage ${r2 ? 'r2' : 'local'}; videos → ${useVdo ? 'VdoCipher' : 'private storage'})`,
  );

  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  /** Source objects moved, and whether every referencing row was rewritten. */
  const sources = new Map<string, { loc: Location; allDone: boolean }>();

  try {
    for (const row of await readRows(db)) {
      const label = `${row.column} #${row.id}`;
      const src = sourceOf(row.value);
      if (!src) {
        bump(
          row.value.startsWith(FILES_PREFIX)
            ? 'already private'
            : 'not ours (left alone)',
        );
        continue;
      }
      if (isForbiddenKey(src.dest) || isForbiddenKey(src.key)) {
        bump('skipped: forbidden key');
        log(`SKIP ${label}: forbidden key ${src.dest}`);
        continue;
      }
      const id = `${src.store}\n${src.key}`;
      const entry = sources.get(id) ?? { loc: src, allDone: true };
      sources.set(id, entry);
      if (!(await exists(src))) {
        // Already moved by an earlier --delete-source run? Then just rewrite.
        if (!(await exists({ store: privateStore(), key: src.dest }))) {
          bump('missing source');
          entry.allDone = false;
          log(`MISSING ${label}: ${row.value}`);
          continue;
        }
      }
      const isVideo =
        row.column === 'lessons.content_url' && row.type === 'video';
      if (isVideo && useVdo) {
        log(
          `${APPLY ? 'IMPORT' : 'would import'} ${label}: ${row.value} → VdoCipher`,
        );
        if (!APPLY) {
          bump('video import');
          continue;
        }
        try {
          const videoId = await vdo.importUrl(
            await importLink(src),
            row.title || `Lesson ${row.id}`,
          );
          // VdoCipher fetches the source asynchronously: never delete it in
          // this run (delete it once the video shows as ready).
          entry.allDone = false;
          if (
            await rewrite(db, row, { video_id: videoId, content_url: null })
          ) {
            bump('video import');
          } else {
            await vdo.deleteBestEffort(videoId);
            entry.allDone = false;
            bump('changed meanwhile');
          }
        } catch (e) {
          entry.allDone = false;
          bump('failed');
          log(`FAILED ${label}: ${String(e)}`);
        }
        continue;
      }
      const to = `${FILES_PREFIX}${src.dest}`;
      log(`${APPLY ? 'MOVE' : 'would move'} ${label}: ${row.value} → ${to}`);
      if (!APPLY) {
        bump('move');
        continue;
      }
      try {
        if (await exists(src)) await copyToPrivate(src);
        if (await rewrite(db, row, { [row.column.split('.')[1]]: to }))
          bump('move');
        else {
          entry.allDone = false;
          bump('changed meanwhile');
        }
      } catch (e) {
        entry.allDone = false;
        bump('failed');
        log(`FAILED ${label}: ${String(e)}`);
      }
    }

    if (APPLY && DELETE_SOURCE) {
      for (const { loc, allDone } of sources.values()) {
        if (!allDone || !(await exists(loc))) continue;
        try {
          await deleteObject(loc);
          bump('source deleted');
        } catch (e) {
          log(`Could not delete ${loc.key}: ${String(e)}`);
        }
      }
    }
  } finally {
    await db.$client.end();
  }
  log('Summary:', counts);
  if (!APPLY) log('Dry run: nothing was changed. Re-run with --apply.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
