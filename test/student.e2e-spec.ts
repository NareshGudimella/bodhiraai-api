process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';

loadEnv();

type Envelope<T = any> = {
  success: boolean;
  message: string | null;
  data: T;
};

/**
 * Student contract checks against the seeded demo data (student@bodhira.test:
 * school 1, grade 10).
 * Read-only apart from the login token, which is revoked at the end.
 */
describe('Student API (e2e)', () => {
  let app: NestExpressApplication;
  let auth: { Authorization: string };

  const get = (path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set(auth);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: 'student@bodhira.test',
        password: 'password',
        device: 'e2e',
      })
      .expect(200);
    auth = {
      Authorization: `Bearer ${(login.body as Envelope<{ token: string }>).data.token}`,
    };
  });

  afterAll(async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set(auth);
    await app.close();
  });

  it('home returns dashboard sections', async () => {
    const { body } = await get('/student/home').expect(200);
    const data = (body as Envelope).data;
    expect(Object.keys(data)).toEqual([
      'student',
      'stats',
      'continue_learning',
      'subjects',
      'upcoming_quizzes',
      // Not in legacy: the web home's Performance Overview.
      'performance',
      'profile_completion_percent',
    ]);
    expect(
      data.subjects.every(
        (s: { grade: string | null }) => s.grade === '10' || s.grade === null,
      ),
    ).toBe(true);
  });

  it('subjects carry chapter counts; subject detail omits them', async () => {
    const list = (await get('/student/subjects').expect(200)).body as Envelope;
    expect(list.data[0]).toHaveProperty('chapters_count');
    const detail = (
      await get(`/student/subjects/${list.data[0].id}`).expect(200)
    ).body as Envelope;
    expect(detail.data.subject).not.toHaveProperty('chapters_count');
  });

  it('enforces subject grade like the legacy controller', async () => {
    // Subject 1 is school 1, grade 9; the student is grade 10.
    const { body } = await get('/student/subjects/1').expect(403);
    expect(body).toEqual({
      success: false,
      message: 'Subject not for your grade.',
    });
  });

  it('mirrors route-model-binding 404s', async () => {
    const { body } = await get('/student/lessons/999999').expect(404);
    expect(body).toEqual({
      success: false,
      message: 'No query results for model [App\\Models\\Lesson] 999999',
    });
  });

  it('lesson detail includes content_body; lesson lists do not', async () => {
    // security: not in legacy — lesson 1 is in a grade 9 subject, which this
    // grade 10 student can no longer open by id. Lesson 68 is in subject 8.
    const detail = (await get('/student/lessons/68').expect(200))
      .body as Envelope;
    expect(detail.data.lesson).toHaveProperty('content_body');
    const list = (await get('/student/chapters/17/lessons').expect(200))
      .body as Envelope;
    expect(list.data.lessons[0]).not.toHaveProperty('content_body');
    expect(list.data).toHaveProperty('quiz_state');
  });

  it('quiz detail never exposes answers', async () => {
    // Quiz 2 is a grade 9 quiz: read it as the grade 9 demo student.
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: 'demo.stu2@bodhira.test',
        password: 'password',
        device: 'e2e',
      })
      .expect(200);
    const grade9 = {
      Authorization: `Bearer ${(login.body as Envelope<{ token: string }>).data.token}`,
    };
    const { body } = await request(app.getHttpServer())
      .get('/api/v1/student/quizzes/2')
      .set(grade9)
      .expect(200);
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set(grade9);
    for (const q of (body as Envelope).data.questions) {
      expect(q).not.toHaveProperty('correct_answer');
      expect(q).not.toHaveProperty('explanation');
    }
  });

  it('reports subscription access', async () => {
    const { body } = await get('/student/access').expect(200);
    expect((body as Envelope).data).toEqual({ has_access: true });
  });

  it('handles parallel requests on one token (MariaDB 1020 regression)', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => get('/student/access')),
    );
    expect(results.map((r) => r.status)).toEqual(Array(25).fill(200));
  });

  it('rejects other roles', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: 'teacher@bodhira.test',
        password: 'password',
        device: 'e2e',
      })
      .expect(200);
    const teacher = {
      Authorization: `Bearer ${(login.body as Envelope<{ token: string }>).data.token}`,
    };
    const { body } = await request(app.getHttpServer())
      .get('/api/v1/student/home')
      .set(teacher)
      .expect(403);
    expect(body).toEqual({
      success: false,
      message: 'You do not have permission to access this resource.',
    });
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set(teacher);
  });
});
