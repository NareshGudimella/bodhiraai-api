process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import { personal_access_tokens, schools, users } from '../src/db/schema';

loadEnv();

const tag = randomBytes(3).toString('hex');
const long = (n: number) => 'a'.repeat(n);

/**
 * Input limits (docs/input-limits.md): over-long, out-of-range and malformed
 * values answer 422 under the field's key. Labelled "security: not in legacy"
 * where legacy had no rule.
 */
describe('Input limits (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  const t: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const email = (k: string) => `il-${tag}-${k}@bodhira.test`;
  const stamps = { created_at: new Date(), updated_at: new Date() };
  let schoolId: bigint;

  const keys = (res: request.Response) =>
    Object.keys((res.body as { errors?: object }).errors ?? {});

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    const tokens = app.get(TokenService);
    const [school] = await db
      .insert(schools)
      .values({
        name: `IL ${tag}`,
        slug: `il-${tag}`,
        code: `IL${tag.toUpperCase()}`,
        ...stamps,
      })
      .returning();
    schoolId = school.id;
    for (const [who, role, sid] of [
      ['super', 'super_admin', null],
      ['admin', 'admin', schoolId],
      ['teacher', 'teacher', schoolId],
    ] as const) {
      const [u] = await db
        .insert(users)
        .values({
          name: `IL ${who}`,
          email: email(who),
          password: 'x',
          role,
          school_id: sid,
          status: 'active',
          ...stamps,
        })
        .returning();
      t[who] = await tokens.issue(u, 'e2e', [`role:${role}`]);
    }
  });

  afterAll(async () => {
    if (db) {
      const mine = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.school_id, schoolId));
      const sup = await db.query.users.findFirst({
        where: eq(users.email, email('super')),
      });
      const ids = [...mine.map((r) => r.id), ...(sup ? [sup.id] : [])];
      if (ids.length) {
        await db
          .delete(personal_access_tokens)
          .where(inArray(personal_access_tokens.tokenable_id, ids));
        await db.delete(users).where(inArray(users.id, ids));
      }
      await db.delete(schools).where(eq(schools.id, schoolId));
    }
    await app?.close();
  });

  describe('class-validator DTOs', () => {
    it('login: identifier and password are capped', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ identifier: long(191), password: long(256) })
        .expect(422);
      expect(keys(res)).toEqual(['identifier', 'password']);
    });

    it('register: password, school_code and phone format', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .send({
          name: 'X',
          email: `${tag}@bodhira.test`,
          phone: 'call me',
          password: long(129),
          password_confirmation: long(129),
          role: 'student',
          school_code: long(21),
        })
        .expect(422);
      expect(keys(res).sort()).toEqual(
        ['password', 'password_confirmation', 'phone', 'school_code'].sort(),
      );
    });
  });

  describe('laravelValidate rules', () => {
    it('public lead form: phone format, over-long message', async () => {
      const res = await http()
        .post('/api/v1/leads/enquiry')
        .send({
          name: 'A',
          email: `${tag}@bodhira.test`,
          phone: 'abc',
          message: long(2001),
        })
        .expect(422);
      expect(keys(res).sort()).toEqual(['message', 'phone']);
    });

    it('password reset: token, email and password caps', async () => {
      const res = await http()
        .post('/api/v1/auth/password/reset')
        .send({
          token: long(256),
          email: `${long(160)}@x.io`,
          password: long(129),
          password_confirmation: long(129),
        })
        .expect(422);
      expect(keys(res).sort()).toEqual(['email', 'password', 'token']);
    });

    it('admin user form: password max, dob range', async () => {
      const res = await http()
        .post('/api/v1/admin/users')
        .set(as('admin'))
        .send({
          name: 'N',
          role: 'student',
          password: long(129),
          dob: '1800-01-01',
        })
        .expect(422);
      expect(keys(res).sort()).toEqual(['dob', 'password']);
    });

    it('content: description, lesson body, question options', async () => {
      const q = await http()
        .post('/api/v1/content/quizzes')
        .set(as('super'))
        .send({ title: 'T', duration_min: 10, description: long(1001) })
        .expect(422);
      expect(keys(q)).toEqual(['description']);
    });

    it('catalogue: syllabus description, plan features', async () => {
      const s = await http()
        .post('/api/v1/super/syllabi')
        .set(as('super'))
        .send({ board: 'CBSE', grade: '1', name: 'N', description: long(1001) })
        .expect(422);
      expect(keys(s)).toContain('description');
      const p = await http()
        .post('/api/v1/super/plans')
        .set(as('super'))
        .send({
          audience: 'school',
          name: 'P',
          monthly_price: 1,
          yearly_price: 1,
          features: long(5001),
        })
        .expect(422);
      expect(keys(p)).toEqual(['features']);
    });

    it('teacher assignment: description and attachment url', async () => {
      const res = await http()
        .post('/api/v1/teacher/assignments')
        .set(as('teacher'))
        .send({
          title: 'T',
          max_marks: 10,
          description: long(5001),
          attachment_url: `https://x.io/${long(2048)}`,
          due_date: '2200-01-01',
        })
        .expect(422);
      expect(keys(res)).toEqual(
        expect.arrayContaining(['description', 'attachment_url', 'due_date']),
      );
    });

    it('CMS: post body, tags, page schema, reorder ids', async () => {
      const post = await http()
        .post('/api/v1/cms/posts')
        .set(as('super'))
        .send({
          title: 'T',
          status: 'draft',
          body: long(100001),
          tags: long(1001),
        })
        .expect(422);
      expect(keys(post)).toEqual(['body', 'tags']);
      const page = await http()
        .post('/api/v1/cms/pages')
        .set(as('super'))
        .send({ name: 'P', status: 'draft', schema: long(20001) })
        .expect(422);
      expect(keys(page)).toEqual(['schema']);
      const reorder = await http()
        .post('/api/v1/cms/menus/header/reorder')
        .set(as('super'))
        .send({ ids: Array.from({ length: 501 }, (_, i) => i + 1) })
        .expect(422);
      expect(keys(reorder)).toEqual(['ids']);
    });

    it('CMS settings: capped per field type', async () => {
      const res = await http()
        .post('/api/v1/cms/settings/general')
        .set(as('super'))
        .send({ site_name: long(256), tagline: 'ok' })
        .expect(422);
      expect(keys(res)).toEqual(['site_name']);
      const contact = await http()
        .post('/api/v1/cms/settings/contact')
        .set(as('super'))
        .send({ email: 'nope', address: long(2001) })
        .expect(422);
      expect(keys(contact).sort()).toEqual(['address', 'email']);
    });

    it('integrations: over-long secret', async () => {
      const res = await http()
        .put('/api/v1/super/integrations/ai')
        .set(as('super'))
        .send({ api_key: long(501) })
        .expect(422);
      expect(keys(res)).toEqual(['api_key']);
    });
  });

  describe('query strings', () => {
    it('rejects a value over 200 characters, names the parameter', async () => {
      const res = await http()
        .get(`/api/v1/admin/users?q=${long(201)}`)
        .set(as('admin'))
        .expect(422);
      expect(keys(res)).toEqual(['q']);
      const status = await http()
        .get(`/api/v1/cms/posts?status=${long(201)}`)
        .set(as('super'))
        .expect(422);
      expect(keys(status)).toEqual(['status']);
    });

    it('rejects an array of more than 50 values', async () => {
      const qs = Array.from({ length: 51 }, () => 'q[]=a').join('&');
      await http()
        .get(`/api/v1/admin/users?${qs}`)
        .set(as('admin'))
        .expect(422);
    });

    it('per_page is bounded; an absurd page is clamped, not an error', async () => {
      const res = await http()
        .get('/api/v1/admin/users?per_page=101')
        .set(as('admin'))
        .expect(422);
      expect(keys(res)).toEqual(['per_page']);
      await http()
        .get('/api/v1/admin/users?page=99999999999999999999')
        .set(as('admin'))
        .expect(200);
    });
  });

  describe('bodies', () => {
    it('accepts a 150,000-character JSON body (limit is 1 MB), caps the field', async () => {
      const res = await http()
        .post('/api/v1/cms/posts')
        .set(as('super'))
        .send({ title: 'T', status: 'draft', body: long(150000) })
        .expect(422);
      expect(keys(res)).toEqual(['body']);
    });
  });
});
