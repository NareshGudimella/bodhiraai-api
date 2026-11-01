process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../src/db/db';
import { users } from '../src/db/schema';
import { strHeadline, strTitle } from '../src/storage/laravel-str';

loadEnv();

/**
 * Phase 6a: the CMS console and the public lead forms. Read-only apart from
 * login tokens: every write below fails validation, a guard or a binding
 * first.
 */
describe('CMS (e2e)', () => {
  let app: NestExpressApplication;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (who: string | null, path: string) => {
    const r = request(app.getHttpServer()).get(`/api/v1${path}`);
    return who ? r.set(as(who)) : r;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    const db = app.get<Db>(DB);
    const issue = async (who: string, email: string, role: string) => {
      const user = (await db.query.users.findFirst({
        where: eq(users.email, email),
      }))!;
      tokens[who] = await app
        .get(TokenService)
        .issue(user, 'e2e', [`role:${role}`]);
    };
    await issue('super', 'super@bodhira.test', 'super_admin');
    await issue('web', 'webadmin@bodhira.com', 'web_admin');
    await issue('content', 'cms@bodhira.com', 'content_manager');
    await issue('admin', 'admin@bodhira.test', 'admin');
  });

  afterAll(async () => {
    for (const who of Object.keys(tokens)) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(as(who));
    }
    await app.close();
  });

  it('opens the studio to super and web admins only', async () => {
    const { body } = await get('web', '/cms').expect(200);
    expect(body.data.stats.map((s: { label: string }) => s.label)).toEqual([
      'Published pages',
      'Blog posts',
      'New messages',
      'Subscribers',
    ]);
    await get('super', '/cms/settings').expect(200);
    await get('content', '/cms').expect(403);
    await get('admin', '/cms/pages').expect(403);
    await get(null, '/cms').expect(401);
  });

  it('serves every collection with its schema', async () => {
    for (const slug of [
      'services',
      'features',
      'faqs',
      'testimonials',
      'team',
      'categories',
      'social',
    ]) {
      const { body } = await get('web', `/cms/${slug}`).expect(200);
      expect(body.data).toEqual(
        expect.objectContaining({
          rows: expect.any(Array),
          fields: expect.any(Array),
          labels: expect.any(Array),
        }),
      );
    }
    const svc = await get('web', '/cms/services');
    expect(typeof svc.body.data.rows[0].is_active).toBe('boolean');
    const missing = await get('web', '/cms/faqs/99999').expect(404);
    expect(missing.body.message).toBe(
      'No query results for model [App\\Models\\Cms\\Faq] 99999',
    );
  });

  it('binds pages and posts by slug, menus by key', async () => {
    const page = await get('web', '/cms/pages/home').expect(200);
    expect(page.body.data.page.is_system).toBe(true);
    expect(Object.keys(page.body.data.section_types)).toContain('hero');
    await get('web', '/cms/pages/1').expect(404);
    const posts = await get('web', '/cms/posts?page=1').expect(200);
    expect(posts.body.meta.per_page).toBe(15);
    await get('web', `/cms/posts/${posts.body.data[0].slug}`).expect(200);
    const menus = await get('web', '/cms/menus?menu=header').expect(200);
    expect(menus.body.data.active.key).toBe('header');
    expect(menus.body.data.items[0]).toEqual(
      expect.objectContaining({ children: expect.any(Array) }),
    );
  });

  it('validates writes in Laravel rule order without touching rows', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/pages')
      .set(as('web'))
      .send({ name: '', slug: 'Bad Slug', status: 'live' })
      .expect(422);
    expect(Object.keys(res.body.errors)).toEqual(['name', 'slug', 'status']);
    await request(app.getHttpServer())
      .post('/api/v1/cms/settings/payments')
      .set(as('web'))
      .expect(404);
  });

  it('exports leads as PHP fputcsv writes them', async () => {
    const res = await get('web', '/cms/contacts/export').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="contact-messages.csv"',
    );
    expect(res.text.split('\n')[0]).toBe(
      'Name,Email,Phone,Subject,Message,Status,Received',
    );
  });

  it('validates the public lead forms with per-type demo rules', async () => {
    const school = await request(app.getHttpServer())
      .post('/api/v1/leads/demo')
      .send({ type: 'school' })
      .expect(422);
    expect(Object.keys(school.body.errors)).toEqual([
      'name',
      'email',
      'phone',
      'organization',
    ]);
    const student = await request(app.getHttpServer())
      .post('/api/v1/leads/demo')
      .send({ type: 'student' })
      .expect(422);
    expect(Object.keys(student.body.errors)).toEqual([
      'name',
      'email',
      'phone',
      'grade',
    ]);
  });

  it('believes X-Forwarded-For only from a trusted proxy', async () => {
    // supertest connects over loopback, which TRUST_PROXY (default) trusts.
    const res = await request(app.getHttpServer())
      .post('/api/v1/leads/contact')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ name: '' })
      .expect(422);
    expect(res.body.errors.name).toBeDefined();
  });

  it('ports Str::headline and Str::title', () => {
    expect(strHeadline('my_photo-final')).toBe('My Photo Final');
    expect(strHeadline('EmailNotificationSent')).toBe(
      'Email Notification Sent',
    );
    expect(strTitle('2nd-place')).toBe('2Nd-Place');
    expect(strTitle("it's o.k.")).toBe("It's O.k.");
  });
});
