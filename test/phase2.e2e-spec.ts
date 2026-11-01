process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';

loadEnv();

/**
 * Phase 2 contract checks (AI tutor, live classes) and the Laravel request
 * behaviours added with them. Non-mutating apart from login tokens, which are
 * revoked.
 */
describe('AI tutor and live classes (e2e)', () => {
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

  it('trims input and treats blank strings as missing (TrimStrings + ConvertEmptyStringsToNull)', async () => {
    const sessions = await request(app.getHttpServer())
      .get('/api/v1/student/ai/sessions')
      .set(as('student'))
      .expect(200);
    const id = sessions.body.data[0].id;
    const res = await request(app.getHttpServer())
      .post(`/api/v1/student/ai/sessions/${id}/messages`)
      .set(as('student'))
      .send({ body: '   ' })
      .expect(422);
    expect(Object.keys(res.body.errors)).toEqual(['body']);
  });

  it('resolves the route binding (404) before validating the body (422)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/student/ai/sessions/999999/messages')
      .set(as('student'))
      .send({})
      .expect(404);
    expect(res.body.message).toBe(
      'No query results for model [App\\Models\\AiChatSession] 999999',
    );
  });

  it('reports the daily token meter', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/student/ai/tokens')
      .set(as('student'))
      .expect(200);
    expect(Object.keys(res.body.data)).toEqual([
      'limit',
      'used',
      'remaining',
      'percent',
    ]);
  });

  it('groups student live classes by status', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/student/live-classes')
      .set(as('student'))
      .expect(200);
    expect(Object.keys(res.body.data)).toEqual([
      'live_now',
      'upcoming',
      'past',
    ]);
  });

  it('validates teacher scheduling like Laravel', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/teacher/live-classes')
      .set(as('teacher'))
      .send({ scope_type: 'class', provider: 'external', duration_min: 2 })
      .expect(422);
    expect(res.body.errors).toEqual({
      title: ['The title field is required.'],
      class_id: ['The class id field is required when scope type is class.'],
      scheduled_at: ['The scheduled at field is required.'],
      duration_min: ['The duration min field must be at least 5.'],
      meeting_url: [
        'The meeting url field is required when provider is external.',
      ],
    });
  });

  it('keeps roles apart', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/teacher/live-classes')
      .set(as('student'))
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/student/ai/sessions')
      .set(as('teacher'))
      .expect(403);
  });
});
