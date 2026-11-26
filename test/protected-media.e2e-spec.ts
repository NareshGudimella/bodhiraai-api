process.env.TZ = 'UTC';

import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { DEV_FILE_URL_SECRET } from '../src/storage/file-url';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  chapters,
  class_subject,
  classes,
  lessons,
  personal_access_tokens,
  schools,
  subjects,
  users,
  video_sessions,
} from '../src/db/schema';
import type { users as User } from '../src/db/types';
import { signFileKey } from '../src/storage/file-url';
import { encryptSecret } from '../src/mail/mail-crypto';
import { signHlsToken } from '../src/video/hls-token';

loadEnv();

const tag = randomBytes(3).toString('hex');
// e2e runs without APP_SECRET (package.json), so links are signed with the dev key.
const SECRET = DEV_FILE_URL_SECRET;
const HLS_KEY = randomBytes(16);
const MASTER =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=896000,RESOLUTION=640x360\n360p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720\n720p.m3u8\n';
const hex32 = () => randomBytes(16).toString('hex');
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  randomBytes(64),
]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/**
 * security: not in legacy. Protected media (2026-11-01): signed private-file
 * links served at /files/*, private uploads, and lesson playback (encrypted
 * HLS, docs/video-hls-contract.md). Private files go to a temporary
 * LOCAL_PRIVATE_DIR. Creates its own schools, users and
 * content (removed afterwards).
 */
describe('Protected media (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let tokens: TokenService;
  let privateDir: string;
  const envBefore: Record<string, string | undefined> = {};
  const createdUsers: bigint[] = [];
  const createdSchools: bigint[] = [];
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  let n = 0;
  async function mkUser(
    role: string,
    extra: Partial<typeof users.$inferInsert> = {},
  ): Promise<{ user: User; token: string }> {
    n += 1;
    const now = new Date();
    const [user] = await db
      .insert(users)
      .values({
        name: `Media ${role} ${n}`,
        email: `media-${tag}-${n}@bodhira.test`,
        phone: `+91${String(parseInt(tag, 16)).padStart(8, '0')}${String(n).padStart(2, '0')}`,
        password: 'x',
        role,
        status: 'active',
        created_at: now,
        updated_at: now,
        ...extra,
      })
      .returning();
    createdUsers.push(user.id);
    return { user, token: await tokens.issue(user, 'e2e', ['role:x']) };
  }

  async function mkSchool(name: string) {
    const now = new Date();
    const [s] = await db
      .insert(schools)
      .values({
        name: `${name} ${tag}`,
        slug: `${name.toLowerCase()}-${tag}`,
        code: `PM${name.slice(0, 2).toUpperCase()}${tag.toUpperCase()}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    createdSchools.push(s.id);
    return s;
  }

  /** A signed URL's path and query, to call on the app. */
  const local = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };
  const putPrivate = async (key: string, bytes: Buffer | string) => {
    const path = join(privateDir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };

  // Fixtures
  let chapterId: bigint;
  let videoLesson: bigint;
  let processingLesson: bigint;
  let failedLesson: bigint;
  let hlsPrefix: string;
  let urlLesson: bigint;
  let textLesson: bigint;
  const t: Record<string, string> = {};
  const u: Record<string, User> = {};

  beforeAll(async () => {
    privateDir = await mkdtemp(join(tmpdir(), 'bodhira-private-'));
    setEnv('LOCAL_PRIVATE_DIR', privateDir);
    setEnv('PUBLIC_URL', 'http://files.e2e.test');
    setEnv('STORAGE_DRIVER', 'local');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    tokens = app.get(TokenService);

    const a = await mkSchool('Alpha');
    const b = await mkSchool('Beta');
    const now = new Date();
    const [subject] = await db
      .insert(subjects)
      .values({
        school_id: a.id,
        name: `Media ${tag}`,
        slug: `media-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [chapter] = await db
      .insert(chapters)
      .values({
        subject_id: subject.id,
        title: 'Chapter',
        slug: `chapter-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    chapterId = chapter.id;
    const lesson = (extra: Partial<typeof lessons.$inferInsert>) =>
      db
        .insert(lessons)
        .values({
          chapter_id: chapter.id,
          title: 'Lesson',
          slug: `lesson-${tag}-${hex32().slice(0, 6)}`,
          created_at: now,
          updated_at: now,
          ...extra,
        })
        .returning();
    [{ id: videoLesson }] = await lesson({ type: 'video' });
    // A ready self-hosted video: encrypted playlists and a stored key.
    hlsPrefix = `hls/${videoLesson}/${tag}/`;
    await db
      .update(lessons)
      .set({
        video_hls_path: hlsPrefix,
        video_hls_key: encryptSecret(HLS_KEY.toString('base64')),
      })
      .where(eq(lessons.id, videoLesson));
    const pl = (body: string) =>
      `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x${'ab'.repeat(16)}\n${body}#EXT-X-ENDLIST\n`;
    await putPrivate(`${hlsPrefix}master.m3u8`, MASTER);
    await putPrivate(
      `${hlsPrefix}360p.m3u8`,
      pl('#EXTINF:6.0,\n360p_00000.ts\n#EXTINF:3.0,\n360p_00001.ts\n'),
    );
    await putPrivate(`${hlsPrefix}360p_00000.ts`, 'segment bytes');
    [{ id: processingLesson }] = await lesson({
      type: 'video',
      video_status: 'processing',
      video_upload_key: `video-imports/lessons/${tag}/x.mp4`,
    });
    [{ id: failedLesson }] = await lesson({
      type: 'video',
      video_status: 'failed',
    });
    [{ id: urlLesson }] = await lesson({
      type: 'video',
      content_url: 'https://cdn.example.test/v.mp4',
    });
    [{ id: textLesson }] = await lesson({ type: 'text' });

    for (const [who, role, school] of [
      ['student', 'student', a.id],
      ['otherStudent', 'student', b.id],
      ['b2c', 'student', null],
      ['classTeacher', 'teacher', a.id],
      ['subjectTeacher', 'teacher', a.id],
      ['otherTeacher', 'teacher', a.id],
      ['betaTeacher', 'teacher', b.id],
      ['admin', 'admin', a.id],
      ['super', 'super_admin', null],
      ['parent', 'parent', a.id],
      ['limited', 'teacher', a.id],
      ['capped', 'teacher', a.id],
    ] as const) {
      const made = await mkUser(role, { school_id: school });
      u[who] = made.user;
      t[who] = made.token;
    }
    const [klass] = await db
      .insert(classes)
      .values({
        school_id: a.id,
        grade: '9',
        section: `M${tag}`,
        class_teacher_id: u.classTeacher.id,
        created_at: now,
        updated_at: now,
      })
      .returning();
    await db.insert(class_subject).values([
      {
        class_id: klass.id,
        subject_id: subject.id,
        teacher_id: u.subjectTeacher.id,
      },
    ]);
    // betaTeacher teaches the subject, but in another school's class.
    const [betaClass] = await db
      .insert(classes)
      .values({
        school_id: b.id,
        grade: '9',
        section: `B${tag}`,
        class_teacher_id: u.betaTeacher.id,
        created_at: now,
        updated_at: now,
      })
      .returning();
    await db.insert(class_subject).values([
      {
        class_id: betaClass.id,
        subject_id: subject.id,
        teacher_id: u.betaTeacher.id,
      },
    ]);
    // `limited` (rate limit test) is class teacher of another class with it in school A.
    const [klass2] = await db
      .insert(classes)
      .values({
        school_id: a.id,
        grade: '9',
        section: `L${tag}`,
        class_teacher_id: u.limited.id,
        created_at: now,
        updated_at: now,
      })
      .returning();
    await db.insert(class_subject).values([
      {
        class_id: klass2.id,
        subject_id: subject.id,
        teacher_id: u.capped.id,
      },
    ]);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (db) {
      if (createdUsers.length) {
        await db
          .delete(video_sessions)
          .where(inArray(video_sessions.user_id, createdUsers));
        await db
          .delete(personal_access_tokens)
          .where(inArray(personal_access_tokens.tokenable_id, createdUsers));
      }
      if (createdSchools.length) {
        const cls = await db
          .select({ id: classes.id })
          .from(classes)
          .where(inArray(classes.school_id, createdSchools));
        if (cls.length)
          await db.delete(class_subject).where(
            inArray(
              class_subject.class_id,
              cls.map((c) => c.id),
            ),
          );
        await db
          .delete(classes)
          .where(inArray(classes.school_id, createdSchools));
        // chapters and lessons cascade from the subject
        await db
          .delete(subjects)
          .where(inArray(subjects.school_id, createdSchools));
      }
      if (createdUsers.length)
        await db.delete(users).where(inArray(users.id, createdUsers));
      if (createdSchools.length)
        await db.delete(schools).where(inArray(schools.id, createdSchools));
    }
    await app?.close();
    if (privateDir) await rm(privateDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ /files
  describe('/files/* (local signed links)', () => {
    const key = `cloud/e2e/${tag}/hello file.txt`;
    const content = 'hello world 0123456789';
    beforeAll(() => putPrivate(key, content));

    it('serves a good link with the contract headers', async () => {
      const res = await http()
        .get(local(signFileKey(key)))
        .expect(200);
      expect(res.text).toBe(content);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      const maxAge = Number(
        /^private, max-age=(\d+)$/.exec(res.headers['cache-control'])?.[1],
      );
      expect(maxAge).toBeGreaterThan(1700);
      expect(maxAge).toBeLessThanOrEqual(1800);
      const head = await http()
        .head(local(signFileKey(key)))
        .expect(200);
      expect(head.headers['content-length']).toBe(String(content.length));
    });

    it('rejects expired, forged and unsigned links', async () => {
      const invalid = { message: 'Link expired or invalid.' };
      const expired = signFileKey(key, { now: Date.now() - 3600_000 });
      expect((await http().get(local(expired)).expect(403)).body).toEqual(
        invalid,
      );
      const good = local(signFileKey(key));
      const forged = good.replace(
        /sig=([\w-])/,
        (_m, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`,
      );
      expect((await http().get(forged).expect(403)).body).toEqual(invalid);
      await http()
        .get(good.replace(/&sig=.*$/, ''))
        .expect(403);
      await http()
        .get(good.replace('hello%20file', 'other%20file'))
        .expect(403);
      // More than 24 h ahead.
      await http()
        .get(local(signFileKey(key, { ttl: 90_000 })))
        .expect(403);
    });

    it('never serves invoices or traversal keys, even with a valid HMAC', async () => {
      await putPrivate('invoices/1/INV-E2E.pdf', PDF);
      const exp = Math.floor(Date.now() / 1000) + 600;
      for (const k of [
        'invoices/1/INV-E2E.pdf',
        `cloud/../invoices/1/INV-E2E.pdf`,
      ]) {
        const sig = createHmac('sha256', SECRET)
          .update(`${k}\n${exp}`)
          .digest('base64url');
        const path = k.split('/').map(encodeURIComponent).join('/');
        await http().get(`/files/${path}?exp=${exp}&sig=${sig}`).expect(403);
      }
      expect(() => signFileKey('invoices/1/INV-E2E.pdf')).toThrow();
    });

    it('answers 404 for a signed link to a missing object', async () => {
      await http()
        .get(local(signFileKey(`cloud/e2e/${tag}/missing.png`)))
        .expect(404);
    });

    it('serves byte ranges (206) and refuses unsatisfiable ones (416)', async () => {
      const url = local(signFileKey(key));
      const a = await http().get(url).set('Range', 'bytes=0-4').expect(206);
      expect(a.text).toBe('hello');
      expect(a.headers['content-range']).toBe(`bytes 0-4/${content.length}`);
      const b = await http().get(url).set('Range', 'bytes=-4').expect(206);
      expect(b.text).toBe('6789');
      const c = await http().get(url).set('Range', 'bytes=6-').expect(206);
      expect(c.text).toBe(content.slice(6));
      const d = await http().get(url).set('Range', 'bytes=999-').expect(416);
      expect(d.headers['content-range']).toBe(`bytes */${content.length}`);
    });
  });

  // -------------------------------------------------------- signed responses
  describe('private columns in responses and uploads', () => {
    it('stores an avatar upload privately and returns a signed link', async () => {
      const res = await http()
        .post('/api/v1/me/profile')
        .set(bearer(t.parent))
        .field('name', u.parent.name)
        .attach('avatar', PNG, 'me.png')
        .expect(200);
      const avatar = res.body.data.avatar as string;
      expect(avatar).toMatch(
        /^http:\/\/files\.e2e\.test\/files\/cloud\/\d{4}\/\d{2}\/\d{2}\/me-[A-Za-z0-9]{8}\.png\?exp=\d+&sig=[\w-]{43}$/,
      );
      const [row] = await db
        .select({ avatar: users.avatar })
        .from(users)
        .where(eq(users.id, u.parent.id));
      expect(row.avatar).toMatch(/^\/files\/cloud\//);
      const file = await http().get(local(avatar)).expect(200);
      expect(file.headers['content-type']).toBe('image/png');
      const me = await http()
        .get('/api/v1/auth/me')
        .set(bearer(t.parent))
        .expect(200);
      expect(me.body.data.avatar).toMatch(
        /^http:\/\/files\.e2e\.test\/files\/cloud\//,
      );
    });

    it('leaves external and legacy values unchanged', async () => {
      await db
        .update(users)
        .set({ avatar: '/cloud/legacy/a.png' })
        .where(eq(users.id, u.admin.id));
      const me = await http()
        .get('/api/v1/auth/me')
        .set(bearer(t.admin))
        .expect(200);
      expect(me.body.data.avatar).toBe('/cloud/legacy/a.png');
    });

    it('uploads a lesson PDF privately, signs it, and takes the signed link back', async () => {
      const created = await http()
        .post(`/api/v1/content/chapters/${chapterId}/lessons`)
        .set(bearer(t.super))
        .field('title', 'PDF lesson')
        .field('type', 'pdf')
        .attach('content_file', PDF, 'notes.pdf')
        .attach('thumbnail_file', PNG, 'thumb.png')
        .expect(201);
      const id = created.body.data.id as number;
      const [row] = await db
        .select()
        .from(lessons)
        .where(eq(lessons.id, BigInt(id)));
      expect(row.content_url).toMatch(
        new RegExp(`^/files/lessons/${chapterId}/notes-\\w{8}\\.pdf$`),
      );
      expect(row.thumbnail).toMatch(
        new RegExp(`^/files/lessons/${chapterId}/thumbnails/`),
      );

      const show = await http()
        .get(`/api/v1/content/lessons/${id}`)
        .set(bearer(t.super))
        .expect(200);
      const l = show.body.data.lesson;
      expect(l.playback).toBe('url');
      expect(l).not.toHaveProperty('video_id');
      expect(l).not.toHaveProperty('video_hls_key');
      expect(l.content_url).toMatch(
        /^http:\/\/files\.e2e\.test\/files\/lessons\/.*\?exp=\d+&sig=/,
      );
      const pdf = await http().get(local(l.content_url)).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');

      // The edit form sends the signed links back: stored as /files/<key> again.
      await http()
        .patch(`/api/v1/content/lessons/${id}`)
        .set(bearer(t.super))
        .field('title', 'PDF lesson')
        .field('type', 'pdf')
        .field('content_url', l.content_url)
        .field('thumbnail', l.thumbnail)
        .expect(200);
      const [after] = await db
        .select()
        .from(lessons)
        .where(eq(lessons.id, BigInt(id)));
      expect(after.content_url).toBe(row.content_url);
      expect(after.thumbnail).toBe(row.thumbnail);

      // A forged link (another key, same signature) is refused.
      const forged = (l.content_url as string).replace('/notes-', '/other-');
      const bad = await http()
        .patch(`/api/v1/content/lessons/${id}`)
        .set(bearer(t.super))
        .field('title', 'PDF lesson')
        .field('type', 'pdf')
        .field('content_url', forged)
        .expect(422);
      expect(bad.body.errors).toEqual({
        content_url: ['The content url field must be a valid URL.'],
      });
    });

    it('keeps uploaded lesson videos private as processing, and drops the replaced HLS video', async () => {
      const created = await http()
        .post(`/api/v1/content/chapters/${chapterId}/lessons`)
        .set(bearer(t.super))
        .field('title', 'Video lesson')
        .field('type', 'video')
        .attach('content_file', WEBM, 'clip.webm')
        .expect(201);
      const id = BigInt(created.body.data.id as number);
      const [row] = await db.select().from(lessons).where(eq(lessons.id, id));
      expect(row.video_id).toBeNull();
      expect(row.content_url).toBeNull();
      expect(row.video_upload_key).toMatch(
        /^video-imports\/lessons\/.*\.webm$/,
      );
      const show = await http()
        .get(`/api/v1/content/lessons/${id}`)
        .set(bearer(t.super))
        .expect(200);
      // Without Redis the job runs inline (it fails on this fake file, which is fine here).
      expect(['processing', null, undefined]).toContain(
        show.body.data.lesson.playback,
      );
      expect(show.body.data.lesson).not.toHaveProperty('video_upload_key');
      expect(show.body.data.lesson).not.toHaveProperty('video_hls_path');
    });

    it('adds playback to student lesson responses', async () => {
      const res = await http()
        .get(`/api/v1/student/lessons/${videoLesson}`)
        .set(bearer(t.student))
        .expect(200);
      expect(res.body.data.lesson.playback).toBe('hls');
      expect(res.body.data.lesson.content_url).toBeNull();
      expect(res.body.data.lesson).not.toHaveProperty('video_id');
      const list = await http()
        .get(`/api/v1/student/chapters/${chapterId}/lessons`)
        .set(bearer(t.student))
        .expect(200);
      const byId = Object.fromEntries(
        (
          list.body.data.lessons as { id: number; playback: string | null }[]
        ).map((l) => [l.id, l.playback]),
      );
      expect(byId[Number(videoLesson)]).toBe('hls');
      expect(byId[Number(urlLesson)]).toBe('url');
      expect(byId[Number(textLesson)]).toBeNull();
    });
  });

  // ----------------------------------------------------- /lessons/:id/playback
  describe('GET /lessons/:id/playback', () => {
    const play = (who: string, id: bigint | number | string) =>
      http().get(`/api/v1/lessons/${id}/playback`).set(bearer(t[who]));
    const cant = { success: false, message: "You can't play this lesson." };

    it('gives an enrolled student an HLS master URL with a token and their email as watermark', async () => {
      const res = await play('student', videoLesson).expect(200);
      expect(res.body.success).toBe(true);
      const d = res.body.data;
      expect(Object.keys(d).sort()).toEqual(
        ['expires_at', 'session', 'type', 'url', 'watermark'].sort(),
      );
      expect(d.type).toBe('hls');
      expect(d.watermark).toMatch(
        new RegExp(
          `^${u.student.email} · ID ${u.student.id} · \\d{2} \\w{3} \\d{4} \\d{2}:\\d{2} IST$`,
        ),
      );
      expect(d.session).toMatch(/^[0-9a-f]{32}$/);
      const [row] = await db
        .select()
        .from(video_sessions)
        .where(eq(video_sessions.id, d.session));
      expect(row).toMatchObject({
        user_id: u.student.id,
        lesson_id: videoLesson,
        key_fetches: 0,
        revoked_at: null,
      });
      expect(row.key_deadline.getTime() - row.created_at.getTime()).toBe(
        600_000,
      );
      expect(d.url).toMatch(
        new RegExp(
          `^http://files\\.e2e\\.test/api/v1/lessons/${videoLesson}/hls/master\\.m3u8\\?t=`,
        ),
      );
      const left = new Date(d.expires_at).getTime() - Date.now();
      expect(left).toBeGreaterThan(5.9 * 3600_000);
      expect(left).toBeLessThanOrEqual(6 * 3600_000);
    });

    it('answers 409 video_processing and video_failed, under both keys', async () => {
      const p = (await play('student', processingLesson).expect(409)).body;
      expect(p).toMatchObject({
        success: false,
        code: 'video_processing',
        error: 'video_processing',
      });
      const f = (await play('student', failedLesson).expect(409)).body;
      expect(f).toMatchObject({
        success: false,
        code: 'video_failed',
        error: 'video_failed',
      });
    });

    it('lets teachers of the subject in the school play it', async () => {
      await play('classTeacher', videoLesson).expect(200);
      await play('subjectTeacher', videoLesson).expect(200);
    });

    it('refuses other students and teachers with 403', async () => {
      expect(
        (await play('otherStudent', videoLesson).expect(403)).body,
      ).toEqual(cant);
      expect(
        (await play('otherTeacher', videoLesson).expect(403)).body,
      ).toEqual(cant);
      expect((await play('betaTeacher', videoLesson).expect(403)).body).toEqual(
        cant,
      );
    });

    it('applies the subscription paywall to B2C students (402)', async () => {
      const res = await play('b2c', videoLesson).expect(402);
      expect(res.body.code).toBe('subscription_inactive');
    });

    // not in legacy (2026-11-01): a school admin may watch its own school's
    // subjects (and used curricula; test/organizations.e2e-spec.ts).
    it('lets the school admin play its own subject, watermarked with the email', async () => {
      const res = await play('admin', videoLesson).expect(200);
      expect(res.body.data.watermark).toContain(`${u.admin.email} · ID `);
    });

    it('refuses super admins and parents', async () => {
      for (const who of ['super', 'parent'])
        expect((await play(who, videoLesson).expect(403)).body).toEqual(cant);
    });

    it('answers 404 for a lesson without a video or a missing lesson', async () => {
      await play('student', textLesson).expect(404);
      await play('student', 999_999_999).expect(404);
    });

    it('returns external video links as type url', async () => {
      const res = await play('student', urlLesson).expect(200);
      expect(res.body.data).toEqual({
        type: 'url',
        url: 'https://cdn.example.test/v.mp4',
      });
    });

    it('requires a token', async () => {
      await http().get(`/api/v1/lessons/${videoLesson}/playback`).expect(401);
    });

    it('limits playback to 60 a minute per user', async () => {
      // The URL lesson creates no session, so only the per-minute limit applies.
      for (let i = 0; i < 60; i++) await play('limited', urlLesson).expect(200);
      await play('limited', urlLesson).expect(429);
      // Another user is unaffected.
      await play('subjectTeacher', videoLesson).expect(200);
    });
  });

  // ------------------------------------------------ /lessons/:id/hls/*
  describe('GET /lessons/:id/hls/:file and /key', () => {
    const base = () => `/api/v1/lessons/${videoLesson}/hls`;
    // Each call starts a new session (and revokes the previous one).
    const token = async (who = 'student') => {
      const res = await http()
        .get(`/api/v1/lessons/${videoLesson}/playback`)
        .set(bearer(t[who]))
        .expect(200);
      return new URL(res.body.data.url).searchParams.get('t') as string;
    };

    it('rewrites the master: variant URIs point at the same route with the same token', async () => {
      const t1 = await token();
      const res = await http().get(`${base()}/master.m3u8?t=${t1}`).expect(200);
      expect(res.headers['content-type']).toMatch(/mpegurl/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const abs = `http://files.e2e.test${base()}`;
      expect(res.text).toContain(`${abs}/360p.m3u8?t=${t1}\n`);
      expect(res.text).toContain(`${abs}/720p.m3u8?t=${t1}\n`);
    });

    it('rewrites a media playlist: signed /files segment links and our key route', async () => {
      const t1 = await token();
      const res = await http().get(`${base()}/360p.m3u8?t=${t1}`).expect(200);
      expect(res.text).toContain(
        `#EXT-X-KEY:METHOD=AES-128,URI="http://files.e2e.test${base()}/key?t=${t1}",IV=0x${'ab'.repeat(16)}`,
      );
      const segs = res.text
        .split('\n')
        .filter((l) => l.startsWith('http://files.e2e.test/files/'));
      expect(segs).toHaveLength(2);
      for (const url of segs)
        expect(url).toMatch(
          new RegExp(
            `^http://files\\.e2e\\.test/files/${hlsPrefix}360p_0000[01]\\.ts\\?exp=\\d+&sig=[\\w-]{43}$`,
          ),
        );
      // The signed link works against the local /files handler.
      const seg = await http().get(local(segs[0])).expect(200);
      expect(seg.headers['content-type']).toBe('video/mp2t');
      expect(seg.headers['content-length']).toBe('13');
    });

    const getKey = (t1: string) =>
      http()
        .get(`${base()}/key?t=${t1}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });

    it('serves the 16-byte key', async () => {
      const res = await getKey(await token()).expect(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toHaveLength(16);
      expect((res.body as Buffer).equals(HLS_KEY)).toBe(true);
    });

    it('answers 403 for a missing, tampered, wrong-lesson or expired token', async () => {
      const good = await token();
      const [s1, u1, e, m] = good.split('.');
      const expired = signHlsToken(s1, videoLesson, u.student.id, 1_000);
      const other = signHlsToken(s1, urlLesson, u.student.id, Number(e));
      for (const path of ['master.m3u8', '360p.m3u8', 'key']) {
        await http().get(`${base()}/${path}`).expect(403);
        for (const bad of [
          'garbage',
          `${s1}.${u1}.${e}.${m.slice(0, -1)}${m.endsWith('A') ? 'B' : 'A'}`,
          `${s1}.${u1}.${Number(e) + 1}.${m}`,
          expired,
          other,
        ])
          await http().get(`${base()}/${path}?t=${bad}`).expect(403);
      }
    });

    it('answers 404 for other files and for a lesson without HLS', async () => {
      const t1 = await token();
      await http().get(`${base()}/360p_00000.ts?t=${t1}`).expect(404);
      await http().get(`${base()}/..%2Fx.m3u8?t=${t1}`).expect(404);
      const [s1, , e] = t1.split('.');
      const t2 = signHlsToken(s1, urlLesson, u.student.id, Number(e));
      await http()
        .get(`/api/v1/lessons/${urlLesson}/hls/master.m3u8?t=${t2}`)
        .expect(403); // no session for that lesson
    });

    // not in legacy: strict playback protection (contract, last section)
    describe('strict playback protection', () => {
      const sessionOf = (t1: string) => t1.split('.')[0];

      it('a second playback revokes the first: its key route gives 403', async () => {
        const first = await token('subjectTeacher');
        const second = await token('subjectTeacher');
        await http().get(`${base()}/key?t=${first}`).expect(403);
        await http().get(`${base()}/master.m3u8?t=${first}`).expect(403);
        const [row] = await db
          .select()
          .from(video_sessions)
          .where(eq(video_sessions.id, sessionOf(first)));
        expect(row.revoked_at).not.toBeNull();
        await getKey(second).expect(200);
      });

      it('serves the key 3 times, then 403', async () => {
        const t1 = await token('classTeacher');
        for (let i = 0; i < 3; i++) await getKey(t1).expect(200);
        await http().get(`${base()}/key?t=${t1}`).expect(403);
        const [row] = await db
          .select()
          .from(video_sessions)
          .where(eq(video_sessions.id, sessionOf(t1)));
        expect(row.key_fetches).toBe(3);
        // Playlists stay open until key_deadline.
        await http().get(`${base()}/360p.m3u8?t=${t1}`).expect(200);
      });

      it('after key_deadline the key and the playlists give 403', async () => {
        const t1 = await token('admin');
        await db
          .update(video_sessions)
          .set({ key_deadline: new Date(Date.now() - 1000) })
          .where(eq(video_sessions.id, sessionOf(t1)));
        await http().get(`${base()}/key?t=${t1}`).expect(403);
        for (const f of ['master.m3u8', '360p.m3u8'])
          await http().get(`${base()}/${f}?t=${t1}`).expect(403);
        const [row] = await db
          .select()
          .from(video_sessions)
          .where(eq(video_sessions.id, sessionOf(t1)));
        expect(row.key_fetches).toBe(0);
      });

      it('allows 20 playbacks an hour; the 21st is 429 playback_limit', async () => {
        const go = () =>
          http()
            .get(`/api/v1/lessons/${videoLesson}/playback`)
            .set(bearer(t.capped));
        for (let i = 0; i < 20; i++) await go().expect(200);
        const res = await go().expect(429);
        expect(res.body).toMatchObject({
          success: false,
          code: 'playback_limit',
          error: 'playback_limit',
        });
        // Only the newest of the 20 is still open.
        const open = await db
          .select()
          .from(video_sessions)
          .where(
            and(
              eq(video_sessions.user_id, u.capped.id),
              eq(video_sessions.lesson_id, videoLesson),
            ),
          );
        expect(open.filter((r) => !r.revoked_at)).toHaveLength(1);
      });

      it('GET /super/video-sessions: super admin only, filterable, newest first', async () => {
        const list = (who: string, q = '') =>
          http().get(`/api/v1/super/video-sessions${q}`).set(bearer(t[who]));
        const res = await list('super', `?user=${u.capped.id}`).expect(200);
        expect(res.body.meta.total).toBe(20);
        expect(res.body.data).toHaveLength(20);
        expect(res.body.data[0]).toMatchObject({
          user_id: Number(u.capped.id),
          lesson_id: Number(videoLesson),
        });
        const times = res.body.data.map((r: { created_at: string }) =>
          Date.parse(r.created_at),
        );
        expect(times).toEqual([...times].sort((x, y) => y - x));
        await list('super', `?lesson=${videoLesson}&page=2`).expect(200);
        for (const who of ['admin', 'student', 'classTeacher', 'parent'])
          await list(who).expect(403);
        await http().get('/api/v1/super/video-sessions').expect(401);
      });
    });
  });
});
