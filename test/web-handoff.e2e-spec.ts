process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import { web_handoff_codes } from '../src/db/schema';

loadEnv();

/**
 * not in legacy: POST /auth/web-handoff and /auth/web-handoff/redeem. Needs the
 * seeded local database. The issue route allows 10 codes an hour per user and
 * the others 8 a minute per address; each route allows 8 requests a minute per address (the
 * login limiter), so this file keeps to 7 issues and 4 redeems.
 */
describe('Web sign-in handoff (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let auth: { Authorization: string };
  let studentName: string;
  const http = () => request(app.getHttpServer());

  const issue = (next: unknown) =>
    http().post('/api/v1/auth/web-handoff').set(auth).send({ next });
  const codeOf = (url: string) => new URL(url).searchParams.get('code')!;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ identifier: 'student@bodhira.test', password: 'password' })
      .expect(200);
    studentName = res.body.data.user.name as string;
    auth = { Authorization: `Bearer ${res.body.data.token as string}` };
  });

  afterAll(async () => {
    await http().post('/api/v1/auth/logout').set(auth);
    await app.close();
  });

  it('issues a code, redeems it once, and refuses a reuse', async () => {
    const res = await issue('/checkout/12').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBeNull();
    const url = res.body.data.url as string;
    expect(url).toMatch(/^https?:\/\/[^/]+\/auth\/handoff\?code=[\w-]{43,}$/);
    const code = codeOf(url);

    // Stored hashed, 60 s lifetime, bound to `next`.
    const hash = createHash('sha256').update(code).digest('hex');
    const row = await db.query.web_handoff_codes.findFirst({
      where: eq(web_handoff_codes.code_hash, hash),
    });
    expect(row?.next).toBe('/checkout/12');
    expect(row?.used_at).toBeNull();
    const ttl = row!.expires_at.getTime() - row!.created_at.getTime();
    expect(ttl).toBe(60_000);

    const redeemed = await http()
      .post('/api/v1/auth/web-handoff/redeem')
      .send({ code })
      .expect(200);
    expect(redeemed.body.success).toBe(true);
    expect(redeemed.body.data.next).toBe('/checkout/12');
    expect(redeemed.body.data.token_type).toBe('Bearer');
    expect(redeemed.body.data.user.email).toBe('student@bodhira.test');

    // The new token works, and is a separate session.
    const webToken = redeemed.body.data.token as string;
    expect(webToken).not.toBe(auth.Authorization.slice(7));
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${webToken}`)
      .expect(200);
    await http()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${webToken}`)
      .expect(200);

    const again = await http()
      .post('/api/v1/auth/web-handoff/redeem')
      .send({ code })
      .expect(422);
    expect(again.body.success).toBe(false);
    expect(again.body.errors.code).toHaveLength(1);
  });

  it('refuses an expired code', async () => {
    const code = codeOf((await issue('/billing').expect(200)).body.data.url);
    await db
      .update(web_handoff_codes)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(
        eq(
          web_handoff_codes.code_hash,
          createHash('sha256').update(code).digest('hex'),
        ),
      );
    await http()
      .post('/api/v1/auth/web-handoff/redeem')
      .send({ code })
      .expect(422);
  });

  it('refuses an unknown code and a missing one', async () => {
    const bad = await http()
      .post('/api/v1/auth/web-handoff/redeem')
      .send({ code: 'nope' })
      .expect(422);
    expect(bad.body.errors.code).toBeDefined();
    await http().post('/api/v1/auth/web-handoff/redeem').send({}).expect(422);
  });

  it('rejects a `next` that is not a relative path', async () => {
    for (const next of [
      '//evil.example',
      'https://evil.example/x',
      '/\\evil',
    ]) {
      const res = await issue(next).expect(422);
      expect(res.body.success).toBe(false);
      expect(res.body.errors.next).toHaveLength(1);
    }
    const missing = await http()
      .post('/api/v1/auth/web-handoff')
      .set(auth)
      .send({})
      .expect(422);
    expect(missing.body.errors.next).toBeDefined();
  });

  const peek = (code: unknown) =>
    http().post('/api/v1/auth/web-handoff/peek').send({ code });

  it('peeks at a code without consuming it', async () => {
    const code = codeOf((await issue('/dashboard').expect(200)).body.data.url);
    // Public: no bearer token.
    const first = await peek(code).expect(200);
    expect(first.body).toEqual({
      success: true,
      message: null,
      data: { name: studentName, role: 'student' },
    });
    await peek(code).expect(200);
    // Still redeemable, once; afterwards peek refuses it like redeem does.
    await http()
      .post('/api/v1/auth/web-handoff/redeem')
      .send({ code })
      .expect(200);
    const used = await peek(code).expect(422);
    expect(used.body.success).toBe(false);
    expect(used.body.errors.code).toHaveLength(1);
  });

  it('refuses to peek at an expired, unknown or missing code', async () => {
    const code = codeOf((await issue('/billing').expect(200)).body.data.url);
    await db
      .update(web_handoff_codes)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(
        eq(
          web_handoff_codes.code_hash,
          createHash('sha256').update(code).digest('hex'),
        ),
      );
    expect((await peek(code).expect(422)).body.errors.code).toBeDefined();
    expect((await peek('nope').expect(422)).body.errors.code).toBeDefined();
    await http().post('/api/v1/auth/web-handoff/peek').send({}).expect(422);
  });

  it('limits issuing to 10 codes an hour per user', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await issue('/x')).status);
    }
    expect(statuses).toContain(429);
    // Everything after the first 429 is refused too.
    const first = statuses.indexOf(429);
    expect(statuses.slice(first).every((s) => s === 429)).toBe(true);
  });

  it('needs a bearer token to issue', async () => {
    await http()
      .post('/api/v1/auth/web-handoff')
      .send({ next: '/' })
      .expect(401);
  });
});
