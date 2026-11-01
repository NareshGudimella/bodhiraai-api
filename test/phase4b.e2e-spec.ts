process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';
import { faststart, isFaststart } from '../src/storage/mp4-faststart';
import { strSlug } from '../src/storage/laravel-str';

loadEnv();

/**
 * Phase 4b: the endpoints for features legacy had only as web routes (content
 * library, quiz builder, syllabi, plans, enquiries, parent links, syllabus
 * opt-in). Read-only apart from login tokens: every write below fails
 * validation or a guard first.
 */
describe('Content, catalogue and school web features (e2e)', () => {
  let app: NestExpressApplication;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (who: string, path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set(as(who));
  const send = (
    who: string,
    method: 'post' | 'patch',
    path: string,
    body: object,
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set(as(who))
      .send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    for (const [who, identifier] of [
      ['admin', 'admin@bodhira.test'],
      ['super', 'super@bodhira.test'],
    ]) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier, password: 'password', device: 'e2e' })
        .expect(200);
      tokens[who] = res.body.data.token;
    }
  });

  afterAll(async () => {
    for (const who of Object.keys(tokens)) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(as(who));
    }
    await app.close();
  });

  it('serves the content library with Eloquent-style counts', async () => {
    const { body } = await get('super', '/content').expect(200);
    expect(Object.keys(body.data.totals)).toEqual([
      'subjects',
      'chapters',
      'lessons',
      'quizzes',
    ]);
    const s = body.data.subjects[0];
    expect(Object.keys(s).slice(-2)).toEqual([
      'chapters_count',
      'quizzes_count',
    ]);
    expect(typeof s.is_active).toBe('boolean');
  });

  it('keeps the content library to super admins', async () => {
    await get('admin', '/content').expect(403);
    await get('super', '/content/subjects/99999').expect(404);
  });

  it('validates lessons like Laravel, before any upload', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/api/v1/content/chapters/1/lessons')
      .set(as('super'))
      .field('title', '')
      .field('type', 'audio')
      .attach('thumbnail_file', Buffer.from('%PDF-1.4'), 'notes.png')
      .expect(422);
    expect(body.errors).toEqual({
      title: ['The title field is required.'],
      type: ['The selected type is invalid.'],
      thumbnail_file: ['The thumbnail file field must be an image.'],
    });
  });

  it('decodes question options and answers', async () => {
    const { body } = await get('super', '/content/quizzes/1').expect(200);
    const q = body.data.quiz.questions[0];
    expect(Array.isArray(q.options)).toBe(true);
    expect(Array.isArray(q.correct_answer)).toBe(true);
  });

  it('checks board + grade together for a new syllabus', async () => {
    const list = await get('super', '/super/syllabi').expect(200);
    const { board, grade } = list.body.data[0];
    const { body } = await send('super', 'post', '/super/syllabi', {
      board,
      grade,
      name: 'Clash',
    }).expect(422);
    expect(body.errors).toEqual({
      grade: ['The grade has already been taken.'],
    });
  });

  it('lists plans with features decoded and validates new ones', async () => {
    const { body } = await get('super', '/super/plans').expect(200);
    expect(Array.isArray(body.data[0].features)).toBe(true);
    const bad = await send('super', 'post', '/super/plans', {
      key: 'Bad Key',
      audience: 'family',
      monthly_price: '-1',
    }).expect(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual([
      'audience',
      'key',
      'monthly_price',
      'name',
      'yearly_price',
    ]);
  });

  it('paginates enquiries with status counts', async () => {
    const { body } = await get('super', '/super/enquiries').expect(200);
    expect(Object.keys(body.data)).toEqual(['enquiries', 'counts', 'status']);
    expect(body.meta.per_page).toBe(20);
  });

  it('serves parent links and syllabus opt-in to school admins only', async () => {
    const links = await get('admin', '/admin/users/5/links').expect(200);
    expect(links.body.data.links[0].pivot).toHaveProperty('relation');
    const neither = await send(
      'admin',
      'post',
      '/admin/users/5/links',
      {},
    ).expect(422);
    expect(neither.body.errors.student_id).toEqual([
      'The student id field is required when parent id is not present.',
    ]);
    const syllabi = await get('admin', '/admin/syllabi').expect(200);
    expect(Object.keys(syllabi.body.data)).toEqual([
      'school',
      'syllabi',
      'opted_ids',
    ]);
    await get('super', '/admin/syllabi').expect(403);
  });

  it('survives parallel sign-ins of one user (MariaDB error 1020)', async () => {
    const login = () =>
      request(app.getHttpServer()).post('/api/v1/auth/login').send({
        identifier: 'admin@bodhira.test',
        password: 'password',
        device: 'e2e',
      });
    const results = await Promise.all(Array.from({ length: 6 }, login));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    for (const r of results) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set({ Authorization: `Bearer ${r.body.data.token}` });
    }
  });

  it('ports Str::slug with a separator and the MP4 faststart remux', () => {
    expect(strSlug('Gold Plan - 2026!', '_')).toBe('gold_plan_2026');
    expect(strSlug('@me Café', '_')).toBe('at_me_cafe');
    // ftyp, mdat, then moov with one stco entry pointing into mdat.
    const box = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(8 + body.length);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, body]);
    };
    const stco = box(
      'stco',
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 24]),
    );
    const moov = box(
      'moov',
      box('trak', box('mdia', box('minf', box('stbl', stco)))),
    );
    const file = Buffer.concat([
      box('ftyp', Buffer.from('isom')),
      box('mdat', Buffer.from('DATA')),
      moov,
    ]);
    expect(isFaststart(file)).toBe(false);
    const out = faststart(file);
    expect(isFaststart(out)).toBe(true);
    // The chunk offset moved forward by the size of moov.
    expect(out.readUInt32BE(12 + moov.length - 4)).toBe(24 + moov.length);
  });
});
