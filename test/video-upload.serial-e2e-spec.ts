process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  integration_settings,
  lessons,
  personal_access_tokens,
  schools,
  subjects,
  users,
} from '../src/db/schema';
import { derivedKey } from '../src/config/app-secret';
import { signUpload } from '../src/video/direct-upload';
import { VideoJobs } from '../src/video/video-jobs.service';

loadEnv();

const tag = randomBytes(3).toString('hex');
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  randomBytes(64),
]);

/**
 * not in legacy: lesson video upload through the API (docs/video-hls-contract.md)
 * against an in-memory S3 stub (R2_ENDPOINT). Serial: it saves the storage
 * integration settings and runs with APP_SECRET set (the proxy-secret rule).
 */
describe('Video upload through the API (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let stub: Server;
  let auth: Record<string, string>;
  let proxy: Record<string, string>;
  let userId: bigint;
  let schoolId: bigint;
  let lessonA: bigint;
  let lessonB: bigint;
  let chapterA: bigint;
  const objects = new Map<string, Buffer>(); // "<bucket>/<key>"
  const envBefore: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const base = (id: bigint) => `/api/v1/content/lessons/${id}/video-upload`;
  const setEnv = (k: string, v: string) => {
    if (!(k in envBefore)) envBefore[k] = process.env[k];
    process.env[k] = v;
  };
  const start = jest.fn().mockResolvedValue(undefined);

  /** Starts an upload for `lesson`; returns the path and query of its stream URL. */
  async function begin(lesson: bigint, size: number, as = auth) {
    const res = await http()
      .post(base(lesson))
      .set(as)
      .send({ filename: 'My Clip.mp4', size, content_type: 'video/mp4' })
      .expect(200);
    const u = new URL(res.body.data.upload_url as string);
    return `${u.pathname}${u.search}`;
  }
  const put = (url: string, body: Buffer) =>
    http().put(url).set('Content-Type', 'video/mp4').send(body);

  beforeAll(async () => {
    const parts = new Map<string, Buffer[]>(); // uploadId -> parts
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const [path, qs = ''] = (req.url ?? '').split('?');
        const q = new URLSearchParams(qs);
        const id = decodeURIComponent(path.slice(4)); // after "/r2/"
        const body = Buffer.concat(chunks);
        res.setHeader('ETag', '"e"');
        if (req.method === 'POST' && q.has('uploads')) {
          parts.set('u1', []);
          res.setHeader('Content-Type', 'application/xml');
          return res.end(
            '<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>',
          );
        }
        if (req.method === 'PUT' && q.has('partNumber')) {
          parts.get('u1')![Number(q.get('partNumber')) - 1] = body;
          return res.end();
        }
        if (req.method === 'POST' && q.has('uploadId')) {
          objects.set(id, Buffer.concat(parts.get('u1')!));
          res.setHeader('Content-Type', 'application/xml');
          return res.end(
            '<CompleteMultipartUploadResult><ETag>"e"</ETag></CompleteMultipartUploadResult>',
          );
        }
        if (req.method === 'PUT') {
          objects.set(id, body);
          return res.end();
        }
        if (req.method === 'DELETE') {
          if (!q.has('uploadId')) objects.delete(id);
          res.statusCode = 204;
          return res.end();
        }
        const obj = objects.get(id);
        if (!obj) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Length', String(obj.length));
        res.end(req.method === 'HEAD' ? undefined : obj);
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const port = (stub.address() as AddressInfo).port;
    setEnv('STORAGE_DRIVER', 'r2');
    setEnv('R2_ENDPOINT', `http://127.0.0.1:${port}/r2`);
    setEnv('APP_SECRET', randomBytes(32).toString('base64'));
    setEnv('CORS_ORIGINS', 'https://site.e2e.test');
    proxy = { 'X-Proxy-Secret': derivedKey('proxy') as string };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(VideoJobs)
      .useValue({ startTranscode: start, deleteHls: jest.fn() })
      .compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);

    const now = new Date();
    const [u] = await db
      .insert(users)
      .values({
        name: 'Video Super',
        email: `vid-${tag}@bodhira.test`,
        phone: `+91${String(parseInt(tag, 16)).padStart(10, '0')}`,
        password: 'x',
        role: 'super_admin',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .returning();
    userId = u.id;
    auth = {
      ...proxy,
      Authorization: `Bearer ${await app.get(TokenService).issue(u, 'e2e', ['role:x'])}`,
    };
    const [school] = await db
      .insert(schools)
      .values({
        name: `Vid ${tag}`,
        slug: `vid-${tag}`,
        code: `VD${tag.toUpperCase()}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    schoolId = school.id;
    const [subject] = await db
      .insert(subjects)
      .values({
        school_id: school.id,
        name: `Vid ${tag}`,
        slug: `vid-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const mkLesson = async (n: number) => {
      const [c] = await db
        .insert(chapters)
        .values({
          subject_id: subject.id,
          title: `C${n}`,
          slug: `c${n}-${tag}`,
          created_at: now,
          updated_at: now,
        })
        .returning();
      const [l] = await db
        .insert(lessons)
        .values({
          chapter_id: c.id,
          title: `L${n}`,
          slug: `l${n}-${tag}`,
          type: 'video',
          is_free: true,
          content_url: 'https://cdn.example.test/old.mp4',
          created_at: now,
          updated_at: now,
        })
        .returning();
      return { l: l.id, c: c.id };
    };
    ({ l: lessonA, c: chapterA } = await mkLesson(1));
    ({ l: lessonB } = await mkLesson(2));
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (db) {
      await db.delete(integration_settings);
      await db
        .delete(personal_access_tokens)
        .where(inArray(personal_access_tokens.tokenable_id, [userId]));
      await db.delete(subjects).where(eq(subjects.school_id, schoolId));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(schools).where(eq(schools.id, schoolId));
    }
    await app?.close();
    stub?.close();
  });

  it('answers multipart while storage is local', async () => {
    setEnv('STORAGE_DRIVER', 'local');
    const res = await http()
      .post(base(lessonA))
      .set(auth)
      .send({ filename: 'a.mp4', size: 10, content_type: 'video/mp4' })
      .expect(200);
    expect(res.body.data).toEqual({ mode: 'multipart' });
    setEnv('STORAGE_DRIVER', 'r2');
  });

  it('saves the storage settings (with a video bucket)', async () => {
    await db.delete(integration_settings);
    await http()
      .put('/api/v1/super/integrations/storage')
      .set(auth)
      .send({
        account_id: 'acc123',
        access_key_id: 'AKIDVIDEO',
        secret_access_key: 'r2-secret-never-shown',
        bucket: 'uploads-e2e',
        public_url: 'https://files.e2e.test',
        private_bucket: 'private-e2e',
        video_bucket: 'video-e2e',
        legacy_bucket: null,
      })
      .expect(200);
  });

  it('answers a stream URL on the API origin, valid 2 h', async () => {
    const res = await http()
      .post(base(lessonA))
      .set(auth)
      .send({
        filename: 'My Clip.mp4',
        size: 4_999_999_999,
        content_type: 'video/mp4',
      })
      .expect(200);
    const d = res.body.data;
    expect(Object.keys(d).sort()).toEqual(['expires_at', 'mode', 'upload_url']);
    expect(d.mode).toBe('stream');
    expect(d.upload_url).toMatch(
      new RegExp(
        `^http://localhost:\\d+/api/v1/content/lessons/${lessonA}/video-upload/stream\\?t=[\\w.-]+$`,
      ),
    );
    const ms = Date.parse(d.expires_at) - Date.now();
    expect(ms).toBeGreaterThan(2 * 3600_000 - 60_000);
    expect(ms).toBeLessThanOrEqual(2 * 3600_000);
  });

  it('rejects a bad extension, type or size with 422, and needs a Bearer', async () => {
    const send = (b: object) => http().post(base(lessonA)).set(auth).send(b);
    const ok = { filename: 'a.mp4', size: 10, content_type: 'video/mp4' };
    expect(
      (await send({ ...ok, filename: 'a.exe' }).expect(422)).body.errors,
    ).toHaveProperty('filename');
    expect(
      (await send({ ...ok, content_type: 'text/html' }).expect(422)).body
        .errors,
    ).toHaveProperty('content_type');
    expect(
      (await send({ ...ok, size: 5_000_000_001 }).expect(422)).body.errors,
    ).toHaveProperty('size');
    await send({}).expect(422);
    await http().post(base(lessonA)).set(proxy).send(ok).expect(401);
  });

  it('streams the file to storage without a Bearer or proxy secret, then marks the lesson processing', async () => {
    const url = await begin(lessonA, MP4.length);
    const res = await put(url, MP4).expect(200); // no auth headers at all
    expect(res.body.data.lesson).toMatchObject({
      id: Number(lessonA),
      video_status: 'processing',
      content_url: null,
      is_free: true,
    });
    const [row] = await db
      .select()
      .from(lessons)
      .where(eq(lessons.id, lessonA));
    expect(row.video_status).toBe('processing');
    expect(row.video_upload_key).toMatch(
      new RegExp(
        `^video-imports/lessons/${chapterA}/my-clip-[A-Za-z0-9]{8}\\.mp4$`,
      ),
    );
    expect(row.content_url).toBeNull();
    expect(objects.get(`video-e2e/${row.video_upload_key}`)).toEqual(MP4);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(lessonA, row.video_upload_key);
  });

  it('streams a file larger than one 16 MB part (multipart upload)', async () => {
    const big = Buffer.concat([MP4, randomBytes(17 * 1024 * 1024)]);
    const url = await begin(lessonB, big.length);
    await put(url, big).expect(200);
    const [row] = await db
      .select()
      .from(lessons)
      .where(eq(lessons.id, lessonB));
    expect(objects.get(`video-e2e/${row.video_upload_key}`)?.equals(big)).toBe(
      true,
    );
  });

  // security: not in legacy: the link is bound to the lesson as it was when issued.
  it('a link is refused once the lesson has changed, and after a successful PUT', async () => {
    const stale = await begin(lessonA, MP4.length);
    await db
      .update(lessons)
      .set({ updated_at: new Date(Date.now() + 60_000) })
      .where(eq(lessons.id, lessonA));
    const before = objects.size;
    await put(stale, MP4).expect(403);
    expect(objects.size).toBe(before);

    const url = await begin(lessonA, MP4.length);
    await put(url, MP4).expect(200);
    const stored = objects.size;
    await put(url, MP4).expect(403); // reused
    expect(objects.size).toBe(stored);
  });

  it('a bad, foreign or expired token is 403', async () => {
    const url = await begin(lessonA, MP4.length);
    await put(url.replace(/t=./, 't=x'), MP4).expect(403);
    await put(
      '/api/v1/content/lessons/' +
        lessonB +
        '/video-upload/stream?t=' +
        url.split('t=')[1],
      MP4,
    ).expect(403);
    await http()
      .put(url.split('?')[0])
      .set('Content-Type', 'video/mp4')
      .send(MP4)
      .expect(403);
    const { token } = signUpload(
      {
        lesson: String(lessonA),
        user: String(userId),
        filename: 'a.mp4',
        size: MP4.length,
        type: 'video/mp4',
        ver: '',
      },
      Date.now() - 3 * 3600_000,
    );
    await put(`${url.split('?')[0]}?t=${token}`, MP4).expect(403);
  });

  it('a Content-Length other than the signed size is 422 and nothing is stored', async () => {
    const before = objects.size;
    const url = await begin(lessonA, MP4.length + 1);
    const res = await put(url, MP4).expect(422);
    expect(res.body.errors).toHaveProperty('size');
    expect(objects.size).toBe(before);
  });

  it('non-video bytes are 422 and nothing is stored', async () => {
    const before = objects.size;
    const text = Buffer.from('<html>definitely not a video</html>');
    const url = await begin(lessonA, text.length);
    await put(url, text).expect(422);
    expect(objects.size).toBe(before);
  });

  it('the proxy-secret rule still guards other routes; the stream route allows PUT from the site origin', async () => {
    await http().get('/api/v1/content/lessons/1').expect(403);
    const res = await http()
      .options(`/api/v1/content/lessons/${lessonA}/video-upload/stream`)
      .set('Origin', 'https://site.e2e.test')
      .set('Access-Control-Request-Method', 'PUT')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://site.e2e.test',
    );
    expect(res.headers['access-control-allow-methods']).toContain('PUT');
    expect(start).toHaveBeenCalledTimes(3); // only the successful uploads
  });
});
