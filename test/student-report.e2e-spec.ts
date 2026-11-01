process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';

loadEnv();

/**
 * GET /student/profile/report (StudentController::profileReport): the PDF
 * attachment. Read-only apart from the login token, which is revoked at the end.
 */
describe('Student PDF report (e2e)', () => {
  let app: NestExpressApplication;
  let auth: { Authorization: string };

  const login = async (identifier: string) => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'password', device: 'e2e' })
      .expect(200);
    return { Authorization: `Bearer ${res.body.data.token as string}` };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    auth = await login('student@bodhira.test');
  });

  afterAll(async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set(auth);
    await app.close();
  });

  it('returns the report as a PDF attachment', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/student/profile/report')
      .set(auth)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="bodhira-report-[a-z0-9-]*\.pdf"$/,
    );
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('is for students only', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/student/profile/report')
      .expect(401);
    const teacher = await login('teacher@bodhira.test');
    await request(app.getHttpServer())
      .get('/api/v1/student/profile/report')
      .set(teacher)
      .expect(403);
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set(teacher);
  });
});
