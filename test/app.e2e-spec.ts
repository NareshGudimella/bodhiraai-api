process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';

loadEnv();

type Envelope<T = unknown> = {
  success: boolean;
  message: string | null;
  data: T;
  errors?: Record<string, string[]>;
};

/**
 * Contract checks against the legacy envelope. Requires DATABASE_URL to point
 * at a database loaded with the Laravel schema and demo seed data.
 */
describe('API contract (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/ping', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/ping')
      .expect(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { service: 'bodhira-api' },
    });
  });

  it('rejects a missing token with the legacy 401 envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401);
    expect(res.body).toEqual({ success: false, message: 'Unauthenticated.' });
  });

  it('returns Laravel-style 422 validation errors', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({})
      .expect(422);
    const body = res.body as Envelope;
    expect(body.success).toBe(false);
    expect(body.errors).toHaveProperty('identifier');
  });

  it('logs in a seeded user, reads /me, and logs out', async () => {
    const server = app.getHttpServer();
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({
        identifier: 'student@bodhira.test',
        password: 'password',
        device: 'e2e',
      })
      .expect(200);
    const { token } = (login.body as Envelope<{ token: string }>).data;
    expect(token).toMatch(/^\d+\|\w{40}$/);
    const auth = { Authorization: `Bearer ${token}` };

    const me = await request(server)
      .get('/api/v1/auth/me')
      .set(auth)
      .expect(200);
    expect((me.body as Envelope).data).toMatchObject({
      email: 'student@bodhira.test',
      role: 'student',
    });

    await request(server).post('/api/v1/auth/logout').set(auth).expect(200);
    await request(server).get('/api/v1/auth/me').set(auth).expect(401);
  });
});
