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
import { personal_access_tokens, users } from '../src/db/schema';
import type { users as User } from '../src/db/types';

loadEnv();

const tag = randomBytes(3).toString('hex');
const STALE = new Date('2020-01-02T03:04:05Z');

/**
 * POST /me/locale (legacy LocaleController): saves the language with
 * forceFill()->save(), so updated_at moves only when the value changes.
 * Uses users made for the test (removed afterwards).
 */
describe('Account locale (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  const createdUsers: bigint[] = [];
  const u: Record<string, User> = {};
  const t: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const post = (who: string, body: unknown) =>
    http()
      .post('/api/v1/me/locale')
      .set({ Authorization: `Bearer ${t[who]}` })
      .send(body as object);
  const reload = async (who: string) =>
    (await db.query.users.findFirst({ where: eq(users.id, u[who].id) }))!;

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
    for (const [who, role] of [
      ['student', 'student'],
      ['teacher', 'teacher'],
    ] as const) {
      const [user] = await db
        .insert(users)
        .values({
          name: `Locale ${who} ${tag}`,
          email: `locale-${tag}-${who}@bodhira.test`,
          password: 'x',
          role,
          status: 'active',
          locale: 'en',
          created_at: STALE,
          updated_at: STALE,
        })
        .returning();
      createdUsers.push(user.id);
      u[who] = user;
      t[who] = await tokens.issue(user, 'e2e', [`role:${role}`]);
    }
  });

  afterAll(async () => {
    if (db && createdUsers.length) {
      await db
        .delete(personal_access_tokens)
        .where(inArray(personal_access_tokens.tokenable_id, createdUsers));
      await db.delete(users).where(inArray(users.id, createdUsers));
    }
    await app?.close();
  });

  it('requires a token', async () => {
    await http().post('/api/v1/me/locale').send({ locale: 'hi' }).expect(401);
  });

  it('validates the locale without writing', async () => {
    const missing = await post('student', {}).expect(422);
    expect(missing.body.errors).toEqual({
      locale: ['The locale field is required.'],
    });
    for (const locale of ['fr', 'HI', ' ', ['hi'], 1]) {
      const res = await post('student', { locale }).expect(422);
      expect(Object.keys(res.body.errors)).toEqual(['locale']);
    }
    const bad = await post('student', { locale: 'fr' }).expect(422);
    expect(bad.body.errors).toEqual({
      locale: ['The selected locale is invalid.'],
    });
    const row = await reload('student');
    expect(row.locale).toBe('en');
    expect(row.updated_at).toEqual(STALE);
  });

  it('keeps updated_at when the locale is unchanged', async () => {
    const res = await post('student', { locale: 'en' }).expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        message: 'Language updated.',
        data: { locale: 'en' },
      }),
    );
    expect((await reload('student')).updated_at).toEqual(STALE);
  });

  it('saves a new locale and moves updated_at', async () => {
    const started = Date.now();
    const res = await post('student', { locale: 'hi' }).expect(200);
    expect(res.body.data).toEqual({ locale: 'hi' });
    const row = await reload('student');
    expect(row.locale).toBe('hi');
    // timestamp(0): compare to the second.
    expect(row.updated_at!.getTime()).toBeGreaterThanOrEqual(
      Math.floor(started / 1000) * 1000 - 1000,
    );
    const changedAt = row.updated_at;

    // The same value again writes nothing (the user is re-read per request).
    await post('student', { locale: 'hi' }).expect(200);
    expect((await reload('student')).updated_at).toEqual(changedAt);

    // Other users are untouched.
    const teacher = await reload('teacher');
    expect(teacher.locale).toBe('en');
    expect(teacher.updated_at).toEqual(STALE);
  });

  it('works for every role', async () => {
    await post('teacher', { locale: 'te' }).expect(200);
    expect((await reload('teacher')).locale).toBe('te');
  });
});
