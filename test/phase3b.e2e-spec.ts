process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';

loadEnv();

/**
 * Phase 3b (new endpoints: student assignments, account, roster). Only
 * validation and access paths here, so nothing is written but login tokens.
 */
describe('Assignments, account, roster (e2e)', () => {
  let app: NestExpressApplication;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    for (const [who, identifier] of [
      ['student', 'student@bodhira.test'],
      ['teacher', 'teacher@bodhira.test'],
      ['b2c', 'aarav1780466327@example.com'],
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

  it('lists only assignments of the student’s classes', async () => {
    const mine = await request(app.getHttpServer())
      .get('/api/v1/student/assignments')
      .set(as('student'))
      .expect(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    await request(app.getHttpServer())
      .get(`/api/v1/student/assignments/${mine.body.data[0].id}`)
      .set(as('b2c'))
      // security: not in legacy — the unsubscribed B2C student is stopped by
      // the subscription gate (402) before the class check (403).
      .expect(402);
  });

  it('validates a multipart submission before storing anything', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/student/assignments/2/submit')
      .set(as('student'))
      .field('note', 'x'.repeat(2001))
      .attach('file', Buffer.from('MZ'), 'run.exe')
      .expect(422);
    expect(res.body.errors.note).toEqual([
      'The note field must not be greater than 2000 characters.',
    ]);
  });

  it('trims multipart fields like Laravel (blank name is required)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/me/profile')
      .set(as('student'))
      .field('name', '   ')
      .expect(422);
    expect(res.body.errors).toEqual({ name: ['The name field is required.'] });
  });

  it('checks the current password', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/me/password')
      .set(as('student'))
      .send({
        current_password: 'nope',
        password: 'abcdefgh1',
        password_confirmation: 'abcdefgh1',
      })
      .expect(422);
    expect(res.body.errors).toEqual({
      current_password: ['The password is incorrect.'],
    });
  });

  it('guards roster changes', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/teacher/classes/1/students/8')
      .set(as('teacher'))
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/teacher/students/8')
      .set(as('teacher'))
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/teacher/classes/1/students')
      .set(as('student'))
      .expect(403);
  });
});
