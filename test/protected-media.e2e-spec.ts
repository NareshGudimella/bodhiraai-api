process.env.TZ = 'UTC';

import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
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
} from '../src/db/schema';
import type { users as User } from '../src/db/types';
import { signFileKey } from '../src/storage/file-url';

loadEnv();

const tag = randomBytes(3).toString('hex');
const SECRET = `e2e-file-url-secret-${tag}-0123456789abcdef`;
const VDO_SECRET = `stub-${tag}`;
const hex32 = () => randomBytes(16).toString('hex');
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  randomBytes(64),
]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

interface StubCall {
  method: string;
  url: string;
  auth?: string;
  body: string;
}

/**
 * security: not in legacy. Protected media (2026-11-01): signed private-file
 * links served at /files/*, private uploads, and lesson playback through
 * VdoCipher. VdoCipher is a local stub (VDOCIPHER_API_BASE); private files go
 * to a temporary LOCAL_PRIVATE_DIR. Creates its own schools, users and
 * content (removed afterwards).
 */
describe('Protected media (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let tokens: TokenService;
  let stub: Server;
  let stubBase: string;
  let privateDir: string;
  const calls: StubCall[] = [];
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
  let urlLesson: bigint;
  let textLesson: bigint;
  const videoId = hex32();
  const t: Record<string, string> = {};
  const u: Record<string, User> = {};

  beforeAll(async () => {
    stub = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        calls.push({
          method: req.method ?? '',
          url: req.url ?? '',
          auth: req.headers.authorization,
          body,
        });
        const json = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (
          req.headers.authorization !== `Apisecret ${VDO_SECRET}` &&
          req.url !== '/upload'
        )
          return json(403, { message: 'bad secret' });
        const url = req.url ?? '';
        if (req.method === 'POST' && /^\/videos\/[a-f0-9]{32}\/otp$/.test(url))
          return json(200, { otp: `otp-${tag}`, playbackInfo: `pbi-${tag}` });
        if (req.method === 'PUT' && url.startsWith('/videos?title='))
          return json(200, {
            videoId: hex32(),
            clientPayload: {
              policy: 'p',
              key: 'k',
              'x-amz-signature': 's',
              'x-amz-algorithm': 'a',
              'x-amz-date': 'd',
              'x-amz-credential': 'c',
              uploadLink: `${stubBase}/upload`,
            },
          });
        if (req.method === 'POST' && url === '/upload') {
          res.writeHead(201);
          return res.end();
        }
        if (req.method === 'DELETE' && url.startsWith('/videos?videos='))
          return json(200, {});
        return json(404, { message: 'no route' });
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    privateDir = await mkdtemp(join(tmpdir(), 'bodhira-private-'));
    setEnv('LOCAL_PRIVATE_DIR', privateDir);
    setEnv('FILE_URL_SECRET', SECRET);
    setEnv('FILES_BASE_URL', 'http://files.e2e.test');
    setEnv('FILE_URL_TTL', '1800');
    setEnv('VDOCIPHER_API_SECRET', VDO_SECRET);
    setEnv('VDOCIPHER_API_BASE', stubBase);
    setEnv('VDOCIPHER_OTP_TTL', undefined);
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
    [{ id: videoLesson }] = await lesson({ type: 'video', video_id: videoId });
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
    await db
      .insert(class_subject)
      .values([{ class_id: klass2.id, subject_id: subject.id }]);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (db) {
      if (createdUsers.length) {
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
    await new Promise((r) => stub?.close(r));
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

    it('sends uploaded lesson videos to VdoCipher and deletes the replaced one', async () => {
      calls.length = 0;
      const created = await http()
        .post(`/api/v1/content/chapters/${chapterId}/lessons`)
        .set(bearer(t.super))
        .field('title', 'Video lesson')
        .field('type', 'video')
        .attach('content_file', WEBM, 'clip.webm')
        .expect(201);
      const id = BigInt(created.body.data.id as number);
      const put = calls.find((c) => c.method === 'PUT');
      expect(put?.url).toBe('/videos?title=Video%20lesson');
      const upload = calls.find((c) => c.url === '/upload');
      expect(upload?.body).toContain('name="success_action_status"');
      expect(upload!.body.indexOf('name="file"')).toBeGreaterThan(
        upload!.body.indexOf('name="x-amz-credential"'),
      );
      const [row] = await db.select().from(lessons).where(eq(lessons.id, id));
      expect(row.video_id).toMatch(/^[a-f0-9]{32}$/);
      expect(row.content_url).toBeNull();
      const show = await http()
        .get(`/api/v1/content/lessons/${id}`)
        .set(bearer(t.super))
        .expect(200);
      expect(show.body.data.lesson.playback).toBe('vdocipher');

      calls.length = 0;
      await http()
        .patch(`/api/v1/content/lessons/${id}`)
        .set(bearer(t.super))
        .field('title', 'Video lesson')
        .field('type', 'video')
        .attach('content_file', WEBM, 'clip2.webm')
        .expect(200);
      expect(
        calls.some(
          (c) =>
            c.method === 'DELETE' && c.url === `/videos?videos=${row.video_id}`,
        ),
      ).toBe(true);
      const [after] = await db.select().from(lessons).where(eq(lessons.id, id));
      expect(after.video_id).not.toBe(row.video_id);
    });

    it('falls back to private storage without a VdoCipher secret (outside production)', async () => {
      setEnv('VDOCIPHER_API_SECRET', undefined);
      try {
        const created = await http()
          .post(`/api/v1/content/chapters/${chapterId}/lessons`)
          .set(bearer(t.super))
          .field('title', 'Local video')
          .field('type', 'video')
          .attach('content_file', WEBM, 'clip.webm')
          .expect(201);
        const id = created.body.data.id as number;
        const [row] = await db
          .select()
          .from(lessons)
          .where(eq(lessons.id, BigInt(id)));
        expect(row.video_id).toBeNull();
        expect(row.content_url).toMatch(/^\/files\/lessons\/.*\.webm$/);
        const play = await http()
          .get(`/api/v1/lessons/${id}/playback`)
          .set(bearer(t.student))
          .expect(200);
        expect(play.body.data.provider).toBe('url');
        const video = await http()
          .get(local(play.body.data.url))
          .set('Range', 'bytes=0-3')
          .expect(206);
        expect(video.headers['content-type']).toBe('video/webm');
      } finally {
        setEnv('VDOCIPHER_API_SECRET', VDO_SECRET);
      }
    });

    it('adds playback to student lesson responses', async () => {
      const res = await http()
        .get(`/api/v1/student/lessons/${videoLesson}`)
        .set(bearer(t.student))
        .expect(200);
      expect(res.body.data.lesson.playback).toBe('vdocipher');
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
      expect(byId[Number(videoLesson)]).toBe('vdocipher');
      expect(byId[Number(urlLesson)]).toBe('url');
      expect(byId[Number(textLesson)]).toBeNull();
    });
  });

  // ----------------------------------------------------- /lessons/:id/playback
  describe('GET /lessons/:id/playback', () => {
    const play = (who: string, id: bigint | number | string) =>
      http().get(`/api/v1/lessons/${id}/playback`).set(bearer(t[who]));
    const cant = { success: false, message: "You can't play this lesson." };

    it('gives an enrolled student a watermarked VdoCipher OTP', async () => {
      calls.length = 0;
      const res = await play('student', videoLesson).expect(200);
      expect(res.body).toEqual({
        success: true,
        message: '',
        data: {
          provider: 'vdocipher',
          otp: `otp-${tag}`,
          playback_info: `pbi-${tag}`,
          expires_in: 300,
        },
      });
      const call = calls.find((c) => c.url === `/videos/${videoId}/otp`);
      expect(call?.auth).toBe(`Apisecret ${VDO_SECRET}`);
      const body = JSON.parse(call!.body) as { ttl: number; annotate: string };
      expect(body.ttl).toBe(300);
      expect(JSON.parse(body.annotate)).toEqual([
        {
          type: 'rtext',
          text: `${u.student.name} · ${u.student.phone}`,
          alpha: '0.60',
          color: '0xFFFFFF',
          size: '15',
          interval: '5000',
        },
      ]);
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
    it('lets the school admin play its own subject, watermarked with name and email', async () => {
      calls.length = 0;
      await play('admin', videoLesson).expect(200);
      const call = calls.find((c) => c.url === `/videos/${videoId}/otp`);
      const body = JSON.parse(call!.body) as { annotate: string };
      expect((JSON.parse(body.annotate) as { text: string }[])[0].text).toBe(
        `${u.admin.name} · ${u.admin.email}`,
      );
    });

    it('refuses super admins and parents', async () => {
      for (const who of ['super', 'parent'])
        expect((await play(who, videoLesson).expect(403)).body).toEqual(cant);
    });

    it('answers 404 for a lesson without a video or a missing lesson', async () => {
      await play('student', textLesson).expect(404);
      await play('student', 999_999_999).expect(404);
    });

    it('returns external video links as provider url', async () => {
      const res = await play('student', urlLesson).expect(200);
      expect(res.body.data).toEqual({
        provider: 'url',
        url: 'https://cdn.example.test/v.mp4',
      });
    });

    it('requires a token', async () => {
      await http().get(`/api/v1/lessons/${videoLesson}/playback`).expect(401);
    });

    it('limits playback to 60 a minute per user', async () => {
      for (let i = 0; i < 60; i++)
        await play('limited', videoLesson).expect(200);
      await play('limited', videoLesson).expect(429);
      // Another user is unaffected.
      await play('subjectTeacher', videoLesson).expect(200);
    });
  });
});
