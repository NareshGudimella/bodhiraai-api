process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { DB, type Db } from '../src/db/db';
import { blog_posts, users } from '../src/db/schema';

loadEnv();

/**
 * Phase 6b: data for the public marketing site and the Site Image Manager.
 * Read-only apart from login tokens: every write below fails a guard or
 * validation first.
 */
describe('Marketing site (e2e)', () => {
  let app: NestExpressApplication;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (path: string, who?: string) => {
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
    for (const [who, email, role] of [
      ['super', 'super@bodhira.test', 'super_admin'],
      ['content', 'cms@bodhira.com', 'content_manager'],
      ['teacher', 'teacher@bodhira.test', 'teacher'],
    ]) {
      const user = (await db.query.users.findFirst({
        where: eq(users.email, email),
      }))!;
      tokens[who] = await app
        .get(TokenService)
        .issue(user, 'e2e', [`role:${role}`]);
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

  it('serves the layout chrome with the page SEO record', async () => {
    const { body } = await get('/site/chrome?path=/about').expect(200);
    expect(Object.keys(body.data)).toEqual([
      'settings',
      'header_menu',
      'footer_menu',
      'social',
      'recent_posts',
      'seo',
      'images',
    ]);
    expect(body.data.seo.slug).toBe('about');
    expect(
      body.data.header_menu.every(
        (i: { parent_id: number | null; is_active: boolean }) =>
          i.parent_id === null && i.is_active,
      ),
    ).toBe(true);
    expect(body.data.recent_posts.length).toBeLessThanOrEqual(2);
    const home = await get('/site/chrome?path=').expect(200);
    expect(home.body.data.seo.slug).toBe('home');
  });

  it('serves the active collections, grouped FAQs and live posts', async () => {
    const { body } = await get('/site/collections').expect(200);
    expect(Object.keys(body.data)).toEqual([
      'team',
      'testimonials',
      'features',
      'services',
    ]);
    expect(
      body.data.services.every((s: { is_active: boolean }) => s.is_active),
    ).toBe(true);
    const faqs = await get('/site/faqs').expect(200);
    expect(Object.values(faqs.body.data.grouped).flat().length).toBeGreaterThan(
      0,
    );
    const blog = await get('/site/blog?page=1').expect(200);
    expect(blog.body.meta.per_page).toBe(9);
    expect(blog.body.data.categories[0]).toEqual(
      expect.objectContaining({ posts_count: expect.any(Number) }),
    );
    await get('/site/success-stories').expect(200);
  });

  it('answers 404 for a missing or unpublished post', async () => {
    const missing = await get('/site/blog/no-such-post').expect(404);
    expect(missing.body.message).toBe(
      'No query results for model [App\\Models\\Cms\\BlogPost] no-such-post',
    );
    const draft = await app.get<Db>(DB).query.blog_posts.findFirst({
      where: and(
        ne(blog_posts.status, 'published'),
        isNull(blog_posts.deleted_at),
      ),
    });
    if (draft) await get(`/site/blog/${draft.slug}`).expect(404);
  });

  it('validates the video id before calling VdoCipher', async () => {
    const bad = await request(app.getHttpServer())
      .get('/api/v1/video/otp?video=nope')
      .expect(422);
    expect(bad.body).toEqual({ error: 'invalid_video_id' });
  });

  it('opens the image manager to CMS roles, with the folder browser for super admins only', async () => {
    const sup = await get('/cms/images', 'super').expect(200);
    expect(sup.body.data.can_browse_all).toBe(true);
    expect(Object.keys(sup.body.data.main)).toContain('Brand');
    const content = await get('/cms/images', 'content').expect(200);
    expect(content.body.data.can_browse_all).toBe(false);
    await get('/cms/images', 'teacher').expect(403);
  });

  it('checks paths before storing anything', async () => {
    const post = (who: string, body: object) =>
      request(app.getHttpServer())
        .post('/api/v1/cms/images/restore')
        .set(as(who))
        .send(body);
    expect(
      (await post('super', { path: 'public/../.env' }).expect(422)).body
        .message,
    ).toBe('Path must be inside assets/img.');
    expect(
      (await post('super', { path: 'assets/img/../../x.png' }).expect(422)).body
        .message,
    ).toBe('Invalid path.');
    // Content managers may touch only the curated main images.
    expect(
      (
        await post('content', {
          path: 'assets/img/shapes/page-header-shape-1.png',
        }).expect(403)
      ).body.message,
    ).toBe('You can only edit the main site images.');
    // Nothing replaced → nothing to restore.
    expect(
      (await post('content', { path: 'assets/img/favicon.png' }).expect(404))
        .body.message,
    ).toBe('No original backup exists for this image.');
    const video = await request(app.getHttpServer())
      .post('/api/v1/cms/images/video')
      .set(as('super'))
      .field('path', 'assets/elsewhere.mp4')
      .expect(422);
    expect(video.body.errors.video).toEqual(['The video field is required.']);
  });

  it('lets public routes see a signed-in caller without requiring one', async () => {
    await get('/site/faqs', 'teacher').expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/site/faqs')
      .set('Authorization', 'Bearer 1|not-a-token')
      .expect(200);
  });
});
