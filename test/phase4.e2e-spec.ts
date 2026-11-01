process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';

loadEnv();

/**
 * Phase 4 contract checks (school admin, super admin) against the demo seed:
 * admin 2 runs school 1, super 1 has no school. Read-only apart from login
 * tokens; the POST below fails validation before any write.
 */
describe('School admin and super admin (e2e)', () => {
  let app: NestExpressApplication;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (who: string, path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set(as(who));

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
        .set(as(who));
    }
    await app.close();
  });

  it('serves the admin dashboard for the admin school', async () => {
    const { body } = await get('admin', '/admin/home').expect(200);
    expect(body.data.admin.school).toBeTruthy();
    expect(Object.keys(body.data.stats)).toEqual([
      'students',
      'teachers',
      'parents',
      'classes',
      'subjects',
      'attendance_percent',
      'active_assignments',
    ]);
  });

  it('paginates users with Laravel meta and validates the query', async () => {
    const { body } = await get(
      'admin',
      '/admin/users?role=student&per_page=2',
    ).expect(200);
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.data.every((u: { role: string }) => u.role === 'student')).toBe(
      true,
    );
    expect(Object.keys(body.meta)).toEqual([
      'current_page',
      'per_page',
      'total',
      'last_page',
    ]);
    const bad = await get(
      'admin',
      '/admin/users?role=wizard&per_page=500',
    ).expect(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual(['per_page', 'role']);
  });

  it('404s an unknown class with the route-binding message', async () => {
    const { body } = await get('admin', '/admin/classes/999').expect(404);
    expect(body.message).toBe(
      'No query results for model [App\\Models\\Klass] 999',
    );
  });

  it('lists enrol and link options for a class (web helper)', async () => {
    const { body } = await get('admin', '/admin/classes/1/options').expect(200);
    expect(Object.keys(body.data)).toEqual([
      'available_students',
      'available_subjects',
      'teachers',
    ]);
  });

  it('validates a new subject before writing', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/api/v1/admin/subjects')
      .set(as('admin'))
      .send({ name: '   ', grade: '12345678901' })
      .expect(422);
    expect(body.errors).toEqual({
      name: ['The name field is required.'],
      grade: ['The grade field must not be greater than 10 characters.'],
    });
  });

  it('keeps each console to its role', async () => {
    await get('student', '/admin/home').expect(403);
    await get('admin', '/super/home').expect(403);
    await get('super', '/admin/home').expect(200);
  });

  it('serves super admin schools, users and revenue', async () => {
    const schools = await get('super', '/super/schools?per_page=2').expect(200);
    expect(schools.body.data.length).toBeLessThanOrEqual(2);
    expect(schools.body.meta.per_page).toBe(2);
    await get('super', '/super/schools?plan=gold').expect(422);
    await get('super', '/super/schools/999').expect(404);
    const users = await get('super', '/super/users?school_id=999').expect(422);
    expect(users.body.errors.school_id).toEqual([
      'The selected school id is invalid.',
    ]);
    const revenue = await get('super', '/super/revenue').expect(200);
    expect(revenue.body.data.arr).toBe(revenue.body.data.mrr * 12);
  });

  it('reports health for this runtime', async () => {
    const { body } = await get('super', '/super/health').expect(200);
    expect(body.data.overall).toBe('healthy');
    expect(body.data.node_version).toBe(process.version);
    expect(body.data.checks.map((c: { name: string }) => c.name)).toEqual([
      'PostgreSQL Database',
      'Storage',
    ]);
  });
});
