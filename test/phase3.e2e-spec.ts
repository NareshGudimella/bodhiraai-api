process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';

loadEnv();

/**
 * Phase 3 contract checks (teacher, parent, chat, notifications) against the
 * demo seed: teacher 3 owns class 1, parent 5 is linked to student 4.
 * Read-only apart from login tokens.
 */
describe('Teacher, parent, chat, notifications (e2e)', () => {
  let app: NestExpressApplication;
  const tokens: Record<string, string> = {};
  const get = (who: string, path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    for (const [who, identifier] of [
      ['teacher', 'teacher@bodhira.test'],
      ['parent', 'parent@bodhira.test'],
      ['student', 'student@bodhira.test'],
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
        .set({ Authorization: `Bearer ${tokens[who]}` });
    }
    await app.close();
  });

  it('serialises the class like Eloquent: relations, pivots, hidden fields', async () => {
    const { body } = await get('teacher', '/teacher/classes/1').expect(200);
    const c = body.data.class;
    expect(Object.keys(c).slice(-3)).toEqual([
      'students',
      'subjects',
      'class_teacher',
    ]);
    expect(Object.keys(c.students[0].pivot)).toEqual([
      'class_id',
      'student_id',
      'roll_no',
      'created_at',
      'updated_at',
    ]);
    expect(c.students[0]).not.toHaveProperty('password');
    expect(c.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000000Z$/);
  });

  it("guards classes, assignments and quizzes the teacher doesn't own", async () => {
    expect(
      (await get('teacher', '/teacher/classes/999').expect(404)).body.message,
    ).toBe('No query results for model [App\\Models\\Klass] 999');
    await get('student', '/teacher/home').expect(403);
  });

  it('links parents only to their own children', async () => {
    await get('parent', '/parent/children/4').expect(200);
    expect(
      (await get('parent', '/parent/children/14').expect(403)).body.message,
    ).toBe('You are not linked to this student.');
    const att = await get(
      'parent',
      '/parent/children/4/attendance?month=2026-06',
    ).expect(200);
    expect(att.body.data.month_label).toBe('June 2026');
  });

  it('lists chat contacts for both roles and blocks students', async () => {
    await get('teacher', '/chat').expect(200);
    await get('parent', '/chat/contacts').expect(200);
    await get('student', '/chat').expect(403);
  });

  it('paginates notifications with unread count', async () => {
    const { body } = await get('student', '/me/notifications').expect(200);
    expect(Object.keys(body.meta)).toEqual([
      'current_page',
      'per_page',
      'total',
      'last_page',
      'unread_count',
    ]);
    const missing = await request(app.getHttpServer())
      .post('/api/v1/me/notifications/nope/read')
      .set({ Authorization: `Bearer ${tokens.student}` })
      .expect(404);
    expect(missing.body.message).toBe(
      'No query results for model [Illuminate\\Notifications\\DatabaseNotification].',
    );
  });
});
