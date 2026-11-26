process.env.TZ = 'UTC';

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  chapters,
  invoices,
  lessons,
  notifications,
  password_reset_tokens,
  personal_access_tokens,
  schools,
  subjects,
  subscriptions,
  users,
} from '../src/db/schema';
import type { users as User } from '../src/db/types';
import { JobsService, QUEUE_NAME } from '../src/jobs/jobs.service';
import { NotificationService } from '../src/notification/notification.service';

loadEnv();

const tag = randomBytes(3).toString('hex');
const PREFIX = `e2e-jobs-${tag}`;
const REDIS = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379';
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  randomBytes(64),
]);

/** Polls `check` until it returns something truthy (10 s). */
async function until<T>(
  check: () => Promise<T | null | undefined | false | 0>,
  what: string,
): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * not in legacy: background jobs with REDIS_URL (local Redis, its own key
 * prefix). The API app only enqueues; a second Nest context in this process
 * is the worker (`src/worker.ts` does the same). Each flow is checked before
 * the worker starts (nothing done yet) and after (done by the worker).
 * Private files go to a temporary directory; the video job runs the real ffmpeg.
 * Creates its own school, users and content (removed afterwards).
 */
describe('Background jobs with Redis (e2e)', () => {
  let app: NestExpressApplication;
  let worker: INestApplicationContext | null = null;
  let db: Db;
  let tokens: TokenService;
  let clip: Buffer;
  let privateDir: string;
  const envBefore: Record<string, string | undefined> = {};
  const createdUsers: bigint[] = [];
  let schoolId: bigint;
  let chapterId: bigint;
  const t: Record<string, string> = {};
  const u: Record<string, User> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const lessonRow = async (id: bigint) =>
    (await db.query.lessons.findFirst({ where: eq(lessons.id, id) }))!;
  const startWorker = async () => {
    worker ??= await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    // The worker reads its own settings (another app context), like the real one.
    worker.get(JobsService).startWorker();
  };

  beforeAll(async () => {
    privateDir = await mkdtemp(join(tmpdir(), 'bodhira-jobs-'));
    setEnv('REDIS_URL', REDIS);
    setEnv('BULLMQ_PREFIX', PREFIX);
    setEnv('LOCAL_PRIVATE_DIR', privateDir);
    setEnv('STORAGE_DRIVER', 'local');
    setEnv('PUBLIC_URL', 'http://files.e2e.test');
    // A 3 s test clip for the transcode job.
    const clipFile = join(privateDir, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=25:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      clipFile,
    ]);
    clip = await readFile(clipFile);
    setEnv('APP_SECRET', undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    // Demo checkout: no gateway configured (the stub's default).
    db = app.get<Db>(DB);
    tokens = app.get(TokenService);

    const now = new Date();
    const [school] = await db
      .insert(schools)
      .values({
        name: `Jobs ${tag}`,
        slug: `jobs-${tag}`,
        code: `JOB${tag.toUpperCase()}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    schoolId = school.id;
    const [subject] = await db
      .insert(subjects)
      .values({
        school_id: school.id,
        name: `Jobs ${tag}`,
        slug: `jobs-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [chapter] = await db
      .insert(chapters)
      .values({
        subject_id: subject.id,
        title: 'Chapter',
        slug: `jobs-chapter-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    chapterId = chapter.id;
    let n = 0;
    for (const [who, role, sid] of [
      ['student', 'student', school.id],
      ['b2c', 'student', null],
      ['super', 'super_admin', null],
    ] as const) {
      n += 1;
      const [user] = await db
        .insert(users)
        .values({
          name: `Jobs ${who}`,
          email: `jobs-${tag}-${n}@bodhira.test`,
          password: 'x',
          role,
          school_id: sid,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .returning();
      createdUsers.push(user.id);
      u[who] = user;
      t[who] = await tokens.issue(user, 'e2e', ['role:x']);
    }
  });

  afterAll(async () => {
    await worker?.close();
    const q = new Queue(QUEUE_NAME, {
      prefix: PREFIX,
      connection: { url: REDIS },
    });
    await q.obliterate({ force: true });
    await q.close();
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (db) {
      await db
        .delete(personal_access_tokens)
        .where(inArray(personal_access_tokens.tokenable_id, createdUsers));
      await db
        .delete(notifications)
        .where(inArray(notifications.notifiable_id, createdUsers));
      await db.delete(invoices).where(inArray(invoices.user_id, createdUsers));
      await db
        .delete(subscriptions)
        .where(inArray(subscriptions.subscribable_id, createdUsers));
      await db
        .delete(password_reset_tokens)
        .where(eq(password_reset_tokens.email, u.b2c.email!));
      // chapters and lessons cascade from the subject
      await db.delete(subjects).where(eq(subjects.school_id, schoolId));
      await db.delete(users).where(inArray(users.id, createdUsers));
      await db.delete(schools).where(eq(schools.id, schoolId));
    }
    await app?.close();
    if (privateDir) await rm(privateDir, { recursive: true, force: true });
  });

  // Filled before the worker starts, checked after.
  const pending: {
    invoice?: number;
    notification?: string;
    lesson?: bigint;
    uploadKey?: string;
  } = {};

  describe('before the worker runs (the API only enqueues)', () => {
    it('answers a password reset neutrally, the email waiting in the queue', async () => {
      const neutral =
        'If an account exists for that email, we have emailed a password reset link.';
      for (const email of [u.b2c.email!, `nobody-${tag}@nowhere.test`]) {
        const res = await http()
          .post('/api/v1/auth/password/forgot')
          .send({ email })
          .expect(200);
        expect(res.body).toEqual({
          success: true,
          message: neutral,
          data: null,
        });
      }
      expect(
        await db.$count(
          password_reset_tokens,
          eq(password_reset_tokens.email, u.b2c.email!),
        ),
      ).toBe(0);
    });

    it('returns the paid invoice at once; the PDF comes from the job (or on demand)', async () => {
      const now = new Date();
      const subs = await db
        .insert(subscriptions)
        .values(
          [1, 2].map(() => ({
            subscribable_type: 'App\\Models\\User',
            subscribable_id: u.b2c.id,
            plan: 'individual_basic',
            status: 'trialing',
            created_at: now,
            updated_at: now,
          })),
        )
        .returning();
      const complete = (id: bigint) =>
        http()
          .post(`/api/v1/billing/checkout/${id}/complete`)
          .set(bearer(t.b2c))
          .send({ cycle: 'monthly' })
          .expect(200);

      // Downloaded before the job runs: rendered on demand.
      const first = (await complete(subs[0].id)).body;
      expect(first.data.status).toBe('paid');
      expect(first.data.pdf_path).toBeNull();
      expect(first.message).toBe(
        `Payment successful · Invoice ${first.data.number} emailed.`,
      );
      const pdf = await http()
        .get(`/api/v1/billing/invoices/${first.data.id}/download`)
        .set(bearer(t.b2c))
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

      // Left for the worker.
      const second = (await complete(subs[1].id)).body;
      expect(second.data.pdf_path).toBeNull();
      pending.invoice = second.data.id as number;
    });

    it('queues notifications instead of writing them', async () => {
      await app
        .get(NotificationService)
        .notifyMany([u.student.id], 'AssignmentPublished', {
          title: `Jobs ${tag}`,
        });
      expect(
        await db.$count(
          notifications,
          eq(notifications.notifiable_id, u.student.id),
        ),
      ).toBe(0);
    });

    it('keeps an uploaded video private and reports it as processing (409 to play)', async () => {
      const created = await http()
        .post(`/api/v1/content/chapters/${chapterId}/lessons`)
        .set(bearer(t.super))
        .field('title', 'Queued video')
        .field('type', 'video')
        .attach('content_file', clip, 'clip.mp4')
        .expect(201);
      const id = BigInt(created.body.data.id as number);
      const row = await lessonRow(id);
      expect(row.video_status).toBe('processing');
      expect(row.video_hls_path).toBeNull();
      expect(row.content_url).toBeNull();
      expect(row.video_upload_key).toMatch(/^video-imports\/lessons\/.*\.mp4$/);
      expect(existsSync(join(privateDir, row.video_upload_key!))).toBe(true);
      pending.lesson = id;
      pending.uploadKey = row.video_upload_key!;

      const show = await http()
        .get(`/api/v1/content/lessons/${id}`)
        .set(bearer(t.super))
        .expect(200);
      expect(show.body.data.lesson.playback).toBe('processing');
      expect(show.body.data.lesson.content_url).toBeNull();
      expect(show.body.data.lesson).not.toHaveProperty('video_upload_key');
      const student = await http()
        .get(`/api/v1/student/lessons/${id}`)
        .set(bearer(t.student))
        .expect(200);
      expect(student.body.data.lesson.playback).toBe('processing');
      const play = await http()
        .get(`/api/v1/lessons/${id}/playback`)
        .set(bearer(t.student))
        .expect(409);
      expect(play.body).toEqual({
        success: false,
        message:
          'This video is still processing. Please try again in a few minutes.',
        code: 'video_processing',
        error: 'video_processing',
      });
    });

    it('reports the queue in the deep /health', async () => {
      const res = await http().get('/health').expect(200);
      expect(res.body.checks.queue).toEqual(
        expect.objectContaining({ status: 'ok' }),
      );
      expect(res.body.checks.queue.waiting).toBeGreaterThanOrEqual(4);
    });
  });

  describe('once the worker runs', () => {
    beforeAll(startWorker);

    it('sends the password reset (a token row for the user)', async () => {
      await until(
        () =>
          db.$count(
            password_reset_tokens,
            eq(password_reset_tokens.email, u.b2c.email!),
          ),
        'the reset token',
      );
    });

    it('renders the invoice PDF, which then downloads', async () => {
      const id = BigInt(pending.invoice!);
      const row = await until(
        async () =>
          (await db.query.invoices.findFirst({ where: eq(invoices.id, id) }))
            ?.pdf_path,
        'the invoice PDF',
      );
      expect(row).toMatch(/^invoices\/\d+\/BDH-INV-\d{4}-\d{5}\.pdf$/);
      await http()
        .get(`/api/v1/billing/invoices/${id}/download`)
        .set(bearer(t.b2c))
        .expect(200)
        .expect('Content-Type', 'application/pdf');
    });

    it('writes the notification rows', async () => {
      const [row] = await until(async () => {
        const rows = await db
          .select()
          .from(notifications)
          .where(eq(notifications.notifiable_id, u.student.id));
        return rows.length ? rows : null;
      }, 'the notification');
      expect(row.type).toBe('App\\Notifications\\AssignmentPublished');
      expect(JSON.parse(row.data)).toEqual({ title: `Jobs ${tag}` });
    });

    it('transcodes the video to encrypted HLS, then plays it and drops the original', async () => {
      const id = pending.lesson!;
      const row = await until(async () => {
        const r = await lessonRow(id);
        return r.video_status === null ? r : null;
      }, 'the video transcode');
      expect(row.video_hls_path).toMatch(
        new RegExp(`^hls/${id}/[0-9a-f]{16}/$`),
      );
      expect(row.video_hls_key).toMatch(/^v1:/);
      expect(row.video_upload_key).toBeNull();
      expect(existsSync(join(privateDir, pending.uploadKey!))).toBe(false);
      for (const f of ['master.m3u8', '360p.m3u8'])
        expect(existsSync(join(privateDir, row.video_hls_path!, f))).toBe(true);
      const play = await http()
        .get(`/api/v1/lessons/${id}/playback`)
        .set(bearer(t.student))
        .expect(200);
      expect(play.body.data.type).toBe('hls');

      // Deleting the lesson deletes its HLS objects through a job.
      await http()
        .delete(`/api/v1/content/lessons/${id}`)
        .set(bearer(t.super))
        .expect(200);
      await until(
        () =>
          Promise.resolve(!existsSync(join(privateDir, row.video_hls_path!))),
        'the HLS delete',
      );
    });

    it('marks a file that is not a video as failed, for the editor to upload again', async () => {
      {
        const created = await http()
          .post(`/api/v1/content/chapters/${chapterId}/lessons`)
          .set(bearer(t.super))
          .field('title', 'Broken video')
          .field('type', 'video')
          .attach('content_file', WEBM, 'broken.webm')
          .expect(201);
        const id = BigInt(created.body.data.id as number);
        const row = await until(async () => {
          const r = await lessonRow(id);
          return r.video_status === 'failed' ? r : null;
        }, 'the failed transcode');
        expect(row.video_hls_path).toBeNull();
        expect(row.video_upload_key).toBeNull();
        const show = await http()
          .get(`/api/v1/content/lessons/${id}`)
          .set(bearer(t.super))
          .expect(200);
        expect(show.body.data.lesson.playback).toBeNull();
        expect(show.body.data.lesson.video_status).toBe('failed');
        const play = await http()
          .get(`/api/v1/lessons/${id}/playback`)
          .set(bearer(t.student))
          .expect(409);
        expect(play.body.code).toBe('video_failed');
        expect(play.body.error).toBe('video_failed');
      }
    });

    it('leaves nothing failed in the queue', async () => {
      const counts = await app.get(JobsService).counts();
      expect(counts?.failed).toBe(1); // the unreadable video above
      const rows = await db
        .select({ id: lessons.id })
        .from(lessons)
        .where(
          and(
            eq(lessons.chapter_id, chapterId),
            eq(lessons.video_status, 'processing'),
          ),
        );
      expect(rows).toEqual([]);
    });
  });
});
