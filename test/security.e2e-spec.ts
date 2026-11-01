process.env.TZ = 'UTC';

import { createHmac, randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ClaudeClient } from '../src/ai/claude.client';
import { AuthService } from '../src/auth/auth.service';
import { hashPassword } from '../src/auth/password';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  ai_chat_messages,
  ai_chat_sessions,
  otp_attempts,
  password_reset_tokens,
  payments,
  personal_access_tokens,
  schools,
  subscriptions,
  users,
} from '../src/db/schema';
import type { users as User } from '../src/db/types';

loadEnv();

const DAY = 86_400_000;
const tag = randomBytes(3).toString('hex');

/**
 * Security fixes (not in legacy): approval for self-registered teachers and
 * parents, seat caps on sign-up, OTP hardening, token status/expiry/revocation,
 * demo billing, webhook replay, the health probe, and AI budget metering.
 * Creates its own school and users (removed afterwards). Route limits are per
 * app instance, so the file keeps under them: 8 a minute on register, login,
 * otp/verify and /me/password.
 */
describe('Security hardening (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let tokens: TokenService;
  let auth: AuthService;
  let schoolId: bigint;
  const created: bigint[] = [];
  const envBefore: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  let n = 0;
  async function mkUser(
    role: string,
    extra: Partial<typeof users.$inferInsert> = {},
  ): Promise<User> {
    n += 1;
    const now = new Date();
    const [row] = await db
      .insert(users)
      .values({
        name: `Sec ${role} ${n}`,
        email: `sec-${tag}-${n}@bodhira.test`,
        password: await hashPassword('password123'),
        role,
        school_id: schoolId,
        status: 'active',
        created_at: now,
        updated_at: now,
        ...extra,
      })
      .returning();
    created.push(row.id);
    return row;
  }
  const tokenFor = (u: User, device = 'android') =>
    tokens.issue(u, device, ['role:x']);
  const tokenId = (plain: string) => BigInt(plain.split('|')[0]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClaudeClient)
      .useValue(claudeMock)
      .compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    tokens = app.get(TokenService);
    auth = app.get(AuthService);
    const now = new Date();
    const [school] = await db
      .insert(schools)
      .values({
        name: `Sec School ${tag}`,
        slug: `sec-school-${tag}`,
        code: `SEC${tag.toUpperCase()}`,
        max_teachers: 1,
        max_students: 1,
        ai_daily_token_limit: 1000,
        created_at: now,
        updated_at: now,
      })
      .returning();
    schoolId = school.id;
  });

  afterAll(async () => {
    restoreEnv();
    if (created.length) {
      await db
        .delete(personal_access_tokens)
        .where(inArray(personal_access_tokens.tokenable_id, created));
      await db
        .delete(ai_chat_sessions)
        .where(inArray(ai_chat_sessions.user_id, created));
      await db
        .delete(subscriptions)
        .where(inArray(subscriptions.subscribable_id, created));
      await db.delete(users).where(inArray(users.id, created));
    }
    await db.delete(payments).where(eq(payments.school_id, schoolId));
    await db.delete(schools).where(eq(schools.id, schoolId));
    await app.close();
  });

  // ---------------------------------------------------------------- 1
  describe('self-registration', () => {
    const body = (role: string, i: number, extra = {}) => ({
      name: `Reg ${role} ${i}`,
      email: `reg-${tag}-${role}-${i}@bodhira.test`,
      password: 'password123',
      password_confirmation: 'password123',
      role,
      ...extra,
    });
    const cleanup = async (email: string) => {
      const u = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
      if (u) created.push(u.id);
      return u;
    };

    it('holds a new teacher for approval, with no token, and login says why', async () => {
      const b = body('teacher', 1, { school_code: `SEC${tag.toUpperCase()}` });
      const res = await http()
        .post('/api/v1/auth/register')
        .send(b)
        .expect(201);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/awaiting approval from your school/);
      expect(res.body.data.token).toBeNull();
      expect(res.body.data.pending_approval).toBe(true);
      expect(res.body.data.user.status).toBe('on_hold');
      const u = await cleanup(b.email);
      expect(u?.status).toBe('on_hold');

      const login = await http()
        .post('/api/v1/auth/login')
        .send({ identifier: b.email, password: b.password })
        .expect(403);
      expect(login.body.code).toBe('account_inactive');
      expect(login.body.message).toMatch(/awaiting approval/);

      // A school admin activates it with the existing toggle; then login works.
      const admin = await mkUser('admin');
      const t = await tokenFor(admin);
      const toggled = await http()
        .post(`/api/v1/admin/users/${u!.id}/toggle`)
        .set(bearer(t))
        .expect(200);
      expect(toggled.body.data.status).toBe('active');
      await http()
        .post('/api/v1/auth/login')
        .send({ identifier: b.email, password: b.password })
        .expect(200);
    });

    it('holds a new parent too, and keeps students active', async () => {
      const p = body('parent', 2);
      const res = await http()
        .post('/api/v1/auth/register')
        .send(p)
        .expect(201);
      expect(res.body.data.user.status).toBe('on_hold');
      await cleanup(p.email);

      const s = body('student', 3);
      const stu = await http()
        .post('/api/v1/auth/register')
        .send(s)
        .expect(201);
      expect(stu.body.message).toBe('Account created.');
      expect(stu.body.data.user.status).toBe('active');
      expect(typeof stu.body.data.token).toBe('string');
      await cleanup(s.email);
    });

    it('lets pending sign-ups wait without a seat, and checks the cap on approval', async () => {
      // max_teachers is 1 and the first test's (approved) teacher holds it.
      const t = body('teacher', 4, { school_code: `SEC${tag.toUpperCase()}` });
      const res = await http()
        .post('/api/v1/auth/register')
        .send(t)
        .expect(201);
      expect(res.body.data.pending_approval).toBe(true);
      const pending = await cleanup(t.email);
      expect(pending?.status).toBe('on_hold');

      // Approving it would exceed the cap: refused, and it stays on hold.
      const admin = await mkUser('admin');
      const tok = await tokenFor(admin);
      const toggled = await http()
        .post(`/api/v1/admin/users/${pending!.id}/toggle`)
        .set(bearer(tok))
        .expect(422);
      expect(toggled.body.errors.status[0]).toMatch(
        /Teacher limit reached \(1\)/,
      );
      expect(
        (await db.query.users.findFirst({ where: eq(users.id, pending!.id) }))
          ?.status,
      ).toBe('on_hold');

      // The pending teacher holds no seat in the admin's seat panel.
      const seats = await http()
        .get('/api/v1/admin/users/seats')
        .set(bearer(tok))
        .expect(200);
      expect(seats.body.data.teachers_used).toBe(1);

      // Students are active at once, so their sign-up is still capped.
      await mkUser('student');
      const s = body('student', 5, { school_code: `SEC${tag.toUpperCase()}` });
      const stu = await http()
        .post('/api/v1/auth/register')
        .send(s)
        .expect(422);
      expect(stu.body.errors.role[0]).toMatch(/Student limit reached/);
    });
  });

  // ---------------------------------------------------------------- 2
  describe('phone OTP', () => {
    let phoneN = 0;
    const phone = () =>
      `+9199${tag.replace(/\D/g, '1')}${String(++phoneN).padStart(4, '0')}`;
    const withOtp = async (u: User, code = '123456') => {
      await db
        .update(users)
        .set({
          otp: await hashPassword(code),
          otp_expires_at: new Date(Date.now() + 600_000),
        })
        .where(eq(users.id, u.id));
      await db.delete(otp_attempts).where(eq(otp_attempts.user_id, u.id));
    };
    const reload = (u: User) =>
      db.query.users.findFirst({ where: eq(users.id, u.id) });

    it('answers 503 while OTP_LOGIN_ENABLED is off (and by default in production)', async () => {
      setEnv('OTP_LOGIN_ENABLED', '0');
      const send = await http()
        .post('/api/v1/auth/otp/send')
        .send({ phone: phone() })
        .expect(503);
      expect(send.body.code).toBe('otp_unavailable');
      await http()
        .post('/api/v1/auth/otp/verify')
        .send({ phone: phone(), otp: '123456' })
        .expect(503);

      setEnv('OTP_LOGIN_ENABLED', undefined);
      setEnv('NODE_ENV', 'production');
      await http()
        .post('/api/v1/auth/otp/send')
        .send({ phone: phone() })
        .expect(503);
      setEnv('NODE_ENV', 'test');
    });

    it('does not create a Guest row for an unknown phone, and answers like a known one', async () => {
      const p = phone();
      const res = await http()
        .post('/api/v1/auth/otp/send')
        .send({ phone: p })
        .expect(200);
      expect(res.body.data.phone).toBe(p);
      expect(
        await db.query.users.findFirst({ where: eq(users.phone, p) }),
      ).toBeUndefined();
    });

    it('never issues a code to admin roles or inactive accounts', async () => {
      const admin = await mkUser('admin', { phone: phone() });
      const blocked = await mkUser('student', {
        phone: phone(),
        status: 'blocked',
      });
      for (const u of [admin, blocked]) {
        await http()
          .post('/api/v1/auth/otp/send')
          .send({ phone: u.phone })
          .expect(200);
        expect((await reload(u))?.otp).toBeNull();
      }
    });

    it('issues a code to an active student, and a correct code signs in once', async () => {
      const u = await mkUser('student', { phone: phone() });
      await http()
        .post('/api/v1/auth/otp/send')
        .send({ phone: u.phone })
        .expect(200);
      expect((await reload(u))?.otp).toBeTruthy();
      await withOtp(u);
      const ok = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ phone: u.phone, otp: '123456' })
        .expect(200);
      expect(ok.body.data.user.id).toBe(Number(u.id));
      const again = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ phone: u.phone, otp: '123456' })
        .expect(422);
      expect(again.body.code).toBe('otp_expired');
    });

    it('invalidates the code after 5 wrong attempts', async () => {
      const u = await mkUser('student', { phone: phone() });
      await withOtp(u);
      const wrong = { phone: u.phone!, otp: '000000' };
      for (let i = 0; i < 4; i++) {
        await expect(auth.verifyOtp(wrong)).rejects.toMatchObject({
          response: { code: 'otp_invalid' },
        });
      }
      await expect(auth.verifyOtp(wrong)).rejects.toMatchObject({
        response: { code: 'otp_expired' },
      });
      // Even the right code is dead now.
      await expect(
        auth.verifyOtp({ phone: u.phone!, otp: '123456' }),
      ).rejects.toMatchObject({ response: { code: 'otp_expired' } });
      expect((await reload(u))?.otp).toBeNull();
      // A new OTP starts again from zero.
      await withOtp(u);
      await expect(auth.verifyOtp(wrong)).rejects.toMatchObject({
        response: { code: 'otp_invalid' },
      });
    });

    it('applies the active-status check, and rejects admin accounts', async () => {
      const held = await mkUser('teacher', {
        phone: phone(),
        status: 'on_hold',
      });
      await withOtp(held);
      await expect(
        auth.verifyOtp({ phone: held.phone!, otp: '123456' }),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'account_inactive' },
      });
      const admin = await mkUser('super_admin', { phone: phone() });
      await withOtp(admin);
      await expect(
        auth.verifyOtp({ phone: admin.phone!, otp: '123456' }),
      ).rejects.toMatchObject({ response: { code: 'otp_expired' } });
    });

    it('rate-limits verify per phone across addresses', async () => {
      const p = phone();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        // A different client address each time: only the per-phone limit can stop it.
        const res = await http()
          .post('/api/v1/auth/otp/verify')
          .set('X-Forwarded-For', `10.9.9.${i + 1}`)
          .send({ phone: p, otp: '000000' });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  // ---------------------------------------------------------------- 3
  describe('tokens', () => {
    it('stops working when the account is not active, and works again once it is', async () => {
      const u = await mkUser('student');
      const t = await tokenFor(u);
      await http().get('/api/v1/auth/me').set(bearer(t)).expect(200);
      for (const status of ['on_hold', 'blocked', 'inactive', 'pending']) {
        await db.update(users).set({ status }).where(eq(users.id, u.id));
        await http().get('/api/v1/auth/me').set(bearer(t)).expect(401);
      }
      await db
        .update(users)
        .set({ status: 'active' })
        .where(eq(users.id, u.id));
      await http().get('/api/v1/auth/me').set(bearer(t)).expect(200);
    });

    it('expires web tokens at 30 days and mobile tokens at 90 idle days / 1 year', async () => {
      const u = await mkUser('student');
      const web = await tokenFor(u, 'web');
      const handoff = await tokenFor(u, 'web-handoff');
      const phone = await tokenFor(u, 'ios');
      const rows = await db.query.personal_access_tokens.findMany({
        where: inArray(
          personal_access_tokens.id,
          [web, handoff, phone].map(tokenId),
        ),
      });
      const ttl = (id: string) => {
        const r = rows.find((x) => x.id === tokenId(id))!;
        return Math.round(
          (r.expires_at!.getTime() - r.created_at!.getTime()) / DAY,
        );
      };
      expect(ttl(web)).toBe(30);
      expect(ttl(handoff)).toBe(30);
      expect(ttl(phone)).toBe(365);

      const age = (
        plain: string,
        createdDays: number,
        usedDays: number | null,
        expires?: Date | null,
      ) =>
        db
          .update(personal_access_tokens)
          .set({
            created_at: new Date(Date.now() - createdDays * DAY),
            last_used_at:
              usedDays === null ? null : new Date(Date.now() - usedDays * DAY),
            ...(expires !== undefined && { expires_at: expires }),
          })
          .where(eq(personal_access_tokens.id, tokenId(plain)));
      const me = (plain: string) =>
        http().get('/api/v1/auth/me').set(bearer(plain));

      // Web: the stored expires_at, then the 30-day age (even when expires_at is null, as legacy tokens are).
      await age(web, 31, 0, new Date(Date.now() + DAY));
      await me(web).expect(401);
      await age(web, 29, 0, null);
      await me(web).expect(200);
      await age(web, 31, 0, null);
      await me(web).expect(401);

      // Mobile: sliding 90 days from last use...
      await age(phone, 200, 91, null);
      await me(phone).expect(401);
      await age(phone, 200, 89, null);
      await me(phone).expect(200); // and this request slid it forward
      // ...but never past one year after issue.
      await age(phone, 366, 1, null);
      await me(phone).expect(401);
      // Never used: counted from issue.
      await age(phone, 91, null, null);
      await me(phone).expect(401);
      await age(phone, 400, 0, new Date(Date.now() - DAY));
      await me(phone).expect(401);
    });

    it('revokes every other token on password change, and rate-limits it like login', async () => {
      const u = await mkUser('student');
      const keep = await tokenFor(u);
      const other1 = await tokenFor(u, 'web');
      const other2 = await tokenFor(u, 'ios');
      const change = (current: string, next = 'newpassword1') =>
        http().post('/api/v1/me/password').set(bearer(keep)).send({
          current_password: current,
          password: next,
          password_confirmation: next,
        });
      await change('password123').expect(200);
      await http().get('/api/v1/auth/me').set(bearer(keep)).expect(200);
      await http().get('/api/v1/auth/me').set(bearer(other1)).expect(401);
      await http().get('/api/v1/auth/me').set(bearer(other2)).expect(401);

      // 1 used; 7 more wrong attempts are allowed (8 a minute), then 429.
      const codes: number[] = [];
      for (let i = 0; i < 8; i++)
        codes.push((await change('wrong-password')).status);
      expect(codes.slice(0, 7).every((c) => c === 422)).toBe(true);
      expect(codes[7]).toBe(429);
    });

    it('revokes every token on password reset', async () => {
      const u = await mkUser('student');
      const t1 = await tokenFor(u);
      const t2 = await tokenFor(u, 'web');
      const reset = randomBytes(16).toString('hex');
      await db.insert(password_reset_tokens).values({
        email: u.email!,
        token: await hashPassword(reset),
        created_at: new Date(),
      });
      await http()
        .post('/api/v1/auth/password/reset')
        .send({
          token: reset,
          email: u.email,
          password: 'resetpassword1',
          password_confirmation: 'resetpassword1',
        })
        .expect(200);
      await http().get('/api/v1/auth/me').set(bearer(t1)).expect(401);
      await http().get('/api/v1/auth/me').set(bearer(t2)).expect(401);
    });

    it('TokenService.revokeAllForUser keeps only the excepted token', async () => {
      const u = await mkUser('student');
      const a = await tokenFor(u);
      const b = await tokenFor(u);
      const c = await tokenFor(u);
      await tokens.revokeAllForUser(u.id, tokenId(b));
      await http().get('/api/v1/auth/me').set(bearer(a)).expect(401);
      await http().get('/api/v1/auth/me').set(bearer(b)).expect(200);
      await http().get('/api/v1/auth/me').set(bearer(c)).expect(401);
      await tokens.revokeAllForUser(u.id);
      await http().get('/api/v1/auth/me').set(bearer(b)).expect(401);
    });
  });

  // ---------------------------------------------------------------- 6
  describe('billing', () => {
    it('refuses demo checkout in production unless BILLING_DEMO=1', async () => {
      const u = await mkUser('student');
      const t = await tokenFor(u);
      for (const k of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'STRIPE_SECRET',
      ])
        setEnv(k, undefined);
      setEnv('NODE_ENV', 'production');
      setEnv('BILLING_DEMO', undefined);
      const plan = { plan: 'individual_basic', cycle: 'monthly' };
      const refused = await http()
        .post('/api/v1/billing/paywall/checkout')
        .set(bearer(t))
        .send(plan)
        .expect(503);
      expect(refused.body.code).toBe('payment_unavailable');
      expect(
        await db.query.subscriptions.findFirst({
          where: eq(subscriptions.subscribable_id, u.id),
        }),
      ).toBeUndefined();

      setEnv('BILLING_DEMO', '1');
      await http()
        .post('/api/v1/billing/paywall/checkout')
        .set(bearer(t))
        .send(plan)
        .expect(201);
      setEnv('BILLING_DEMO', undefined);
      setEnv('NODE_ENV', 'test');
    });

    it('applies a captured payment once, however often the webhook is re-sent', async () => {
      setEnv('RAZORPAY_WEBHOOK_SECRET', 'sec-hook-secret');
      const now = new Date();
      const [pay] = await db
        .insert(payments)
        .values({
          school_id: schoolId,
          gateway: 'razorpay',
          plan: 'starter',
          amount_paise: 999900n,
          status: 'pending',
          gateway_order_id: `order_sec_${tag}`,
          created_at: now,
          updated_at: now,
        })
        .returning();
      const send = (event: object, secret = 'sec-hook-secret') => {
        const raw = JSON.stringify(event);
        return http()
          .post('/webhooks/razorpay')
          .set('Content-Type', 'application/json')
          .set(
            'X-Razorpay-Signature',
            createHmac('sha256', secret).update(raw).digest('hex'),
          )
          .send(raw);
      };
      const captured = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: { id: `pay_${tag}`, order_id: `order_sec_${tag}` },
          },
        },
      };
      const school = () =>
        db.query.schools.findFirst({ where: eq(schools.id, schoolId) });

      await send(captured).expect(200);
      const first = await school();
      expect(first?.plan).toBe('starter');
      expect(first?.plan_expires_at).toBeTruthy();

      // Move the school's expiry (as if days had passed), then replay.
      const sentinel = new Date('2030-01-01T00:00:00Z');
      await db
        .update(schools)
        .set({ plan_expires_at: sentinel })
        .where(eq(schools.id, schoolId));
      await send(captured).expect(200);
      await send({
        ...captured,
        event: 'order.paid',
        payload: {
          ...captured.payload,
          order: { entity: { id: `order_sec_${tag}` } },
        },
      }).expect(200);
      expect((await school())?.plan_expires_at?.toISOString()).toBe(
        sentinel.toISOString(),
      );

      // A late failure doesn't undo it.
      await send({ event: 'payment.failed', payload: captured.payload }).expect(
        200,
      );
      const row = await db.query.payments.findFirst({
        where: eq(payments.id, pay.id),
      });
      expect(row?.status).toBe('paid');
    });

    it('does not reveal configuration problems to the sender', async () => {
      setEnv('RAZORPAY_WEBHOOK_SECRET', undefined);
      const res = await http()
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', 'x')
        .send('{"event":"x"}')
        .expect(400);
      expect(res.body).toEqual({ ok: false, error: 'Webhook rejected.' });
      setEnv('RAZORPAY_WEBHOOK_SECRET', 'sec-hook-secret');
      const bad = await http()
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', 'x')
        .send('{"event":"x"}')
        .expect(400);
      expect(bad.body.error).toBe('Invalid Razorpay signature');
    });
  });

  // ---------------------------------------------------------------- 7
  describe('health', () => {
    it('answers only a status to the public in production, the full check otherwise', async () => {
      const deep = await http().get('/health').expect(200);
      expect(deep.body.checks.db.status).toBe('ok');
      expect(deep.body.checks.db.error).toBeUndefined();

      setEnv('NODE_ENV', 'production');
      setEnv('PROXY_SECRET', undefined);
      const live = await http().get('/health').expect(200);
      expect(live.body).toEqual({ status: 'ok' });
      setEnv('NODE_ENV', 'test');
      await http().get('/api/v1/ping').expect(200);
    });
  });

  // ---------------------------------------------------------------- 9
  describe('AI tutor budget', () => {
    it('lets only one of many parallel requests reserve the last of the budget, and meters real usage', async () => {
      const u = await mkUser('student');
      const t = await tokenFor(u);
      const s = await http()
        .post('/api/v1/student/ai/sessions')
        .set(bearer(t))
        .send({})
        .expect(201);
      const id = s.body.data.session.id as number;
      // 1000 a day; a live call reserves input estimate + 1024 max reply.
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          http()
            .post(`/api/v1/student/ai/sessions/${id}/messages`)
            .set(bearer(t))
            .send({ body: 'What is photosynthesis?' }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 429, 429, 429, 429]);

      // The reservation was replaced by the usage Claude reported: 40 in + 10 out.
      const rows = await db.query.ai_chat_messages.findMany({
        where: and(eq(ai_chat_messages.session_id, BigInt(id))),
      });
      const byRole = (r: string) =>
        rows.filter((m) => m.role === r).map((m) => m.tokens);
      expect(byRole('user')).toEqual([40]);
      expect(byRole('assistant')).toEqual([10]);
      // 50 of 1000 are used now, so the next question goes through.
      await http()
        .post(`/api/v1/student/ai/sessions/${id}/messages`)
        .set(bearer(t))
        .send({ body: 'And chlorophyll?' })
        .expect(200);
    });
  });
  // ---------------------------------------------------------------- forgot password
  describe('forgot password', () => {
    it('answers every valid address the same way', async () => {
      const neutral =
        'If an account exists for that email, we have emailed a password reset link.';
      const u = await mkUser('student');
      const send = (email: string) =>
        http().post('/api/v1/auth/password/forgot').send({ email });

      const unknown = await send(`nobody-${tag}@nowhere.test`).expect(200);
      const known = await send(u.email!).expect(200);
      const repeat = await send(u.email!).expect(200); // throttled
      for (const r of [unknown, known, repeat]) {
        expect(r.body).toEqual({ success: true, message: neutral, data: null });
      }
      // A malformed address is still a validation error.
      const bad = await send('not-an-email').expect(422);
      expect(bad.body.errors).toHaveProperty('email');
    });
  });
});

const claudeMock = {
  configured: true,
  reply: async () => {
    await new Promise((r) => setTimeout(r, 300));
    return {
      text: 'Plants make food from light.',
      inputTokens: 40,
      outputTokens: 10,
    };
  },
};
