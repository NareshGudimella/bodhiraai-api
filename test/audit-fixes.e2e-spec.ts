process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthController } from '../src/auth/auth.controller';
import { phoneKey } from '../src/auth/auth.service';
import { hashPassword } from '../src/auth/password';
import { TokenService } from '../src/auth/token.service';
import type { ClientInfo } from '../src/common/decorators/client.decorator';
import { RateLimiter } from '../src/common/rate-limiter';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  invoices,
  otp_attempts,
  personal_access_tokens,
  schools,
  users,
  video_sessions,
} from '../src/db/schema';
import type { classes, users as User } from '../src/db/types';
import { RosterService } from '../src/teacher/roster.service';

loadEnv();

const tag = randomBytes(3).toString('hex');
const DAY = 86_400_000;

/**
 * security: not in legacy. Audit fixes 2026-11-27: invoice ownership, OTP and login limits,
 * upload rate limit, peer-admin edits, session and video revocation on password set or block.
 * Creates its own school and users (removed afterwards). The limiters are per app instance.
 */
describe('Audit fixes (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let tokens: TokenService;
  let limiter: RateLimiter;
  let authController: AuthController;
  let schoolId: bigint;
  const created: bigint[] = [];
  const invoiceIds: bigint[] = [];
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const client = (ip: string) => ({ ip }) as ClientInfo;

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
        name: `Audit ${role} ${n}`,
        email: `audit-${tag}-${n}@bodhira.test`,
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
  const tokenFor = (u: User) => tokens.issue(u, 'android', ['role:x']);
  const tokenCount = async (u: User) =>
    (
      await db
        .select({ id: personal_access_tokens.id })
        .from(personal_access_tokens)
        .where(eq(personal_access_tokens.tokenable_id, u.id))
    ).length;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    tokens = app.get(TokenService);
    limiter = app.get(RateLimiter);
    authController = app.get(AuthController);
    const now = new Date();
    const [school] = await db
      .insert(schools)
      .values({
        name: `Audit School ${tag}`,
        slug: `audit-school-${tag}`,
        code: `AUD${tag.toUpperCase()}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    schoolId = school.id;
  });

  afterAll(async () => {
    if (invoiceIds.length)
      await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    if (created.length) {
      await db
        .delete(video_sessions)
        .where(inArray(video_sessions.user_id, created));
      await db
        .delete(personal_access_tokens)
        .where(inArray(personal_access_tokens.tokenable_id, created));
      await db.delete(users).where(inArray(users.id, created));
    }
    await db.delete(schools).where(eq(schools.id, schoolId));
    await app.close();
  });

  it('refuses an invoice with no owner (403), allows the owner', async () => {
    const student = await mkUser('student');
    const t = await tokenFor(student);
    const now = new Date();
    const mk = async (userId: bigint | null, suffix: string) => {
      const [row] = await db
        .insert(invoices)
        .values({
          number: `AF-${tag}-${suffix}`,
          user_id: userId,
          plan_key: 'x',
          plan_name: 'X',
          amount_paise: 100n,
          total_paise: 100n,
          issued_at: now,
        })
        .returning();
      invoiceIds.push(row.id);
      return row;
    };
    const orphan = await mk(null, 'o');
    const own = await mk(student.id, 'm');
    await http()
      .get(`/api/v1/billing/invoices/${orphan.id}`)
      .set(bearer(t))
      .expect(403);
    await http()
      .get(`/api/v1/billing/invoices/${orphan.id}/download`)
      .set(bearer(t))
      .expect(403);
    await http()
      .get(`/api/v1/billing/invoices/${own.id}`)
      .set(bearer(t))
      .expect(200);
  });

  describe('phone OTP', () => {
    let phoneN = 0;
    const phone = () =>
      `+9198${tag.replace(/\D/g, '1')}${String(++phoneN).padStart(4, '0')}`;

    it('a new send does not reset the wrong-code counter', async () => {
      const u = await mkUser('student', { phone: phone() });
      await db
        .insert(otp_attempts)
        .values({ user_id: u.id, attempts: 3, updated_at: new Date() });
      await authController.sendOtp({ phone: u.phone! }, client('10.1.0.1'));
      const row = await db.query.otp_attempts.findFirst({
        where: eq(otp_attempts.user_id, u.id),
      });
      expect(row?.attempts).toBe(3);
      expect(
        (await db.query.users.findFirst({ where: eq(users.id, u.id) }))?.otp,
      ).toBeTruthy();
    });

    it('allows 5 sends a day per phone, then 429, for known and unknown phones alike', async () => {
      for (const p of [
        phone(),
        (await mkUser('student', { phone: phone() })).phone!,
      ]) {
        for (let i = 0; i < 5; i++)
          await authController.sendOtp({ phone: p }, client(`10.2.0.${i}`));
        await expect(
          authController.sendOtp({ phone: p }, client('10.2.0.9')),
        ).rejects.toMatchObject({ status: 429 });
      }
    });

    it('locks the phone after 10 wrong codes in 24 h, even for the right code', async () => {
      const u = await mkUser('student', { phone: phone() });
      await db
        .update(users)
        .set({
          otp: await hashPassword('123456'),
          otp_expires_at: new Date(Date.now() + 600_000),
        })
        .where(eq(users.id, u.id));
      for (let i = 0; i < 10; i++)
        await limiter.hit('otp-wrong', phoneKey(u.phone!), 10, DAY);
      const res = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ phone: u.phone, otp: '123456' });
      expect(res.status).toBe(429);
    });

    it('counts every verify attempt and answers 429 on the 11th', async () => {
      const p = phone();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++)
        statuses.push(
          await authController
            .verifyOtp({ phone: p, otp: '000000' })
            .then(() => 200)
            .catch((e: { status: number }) => e.status),
        );
      expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  it('limits login attempts per account (10 in 15 min) with the usual 429, known or unknown', async () => {
    const u = await mkUser('student');
    const bodies: unknown[] = [];
    for (const identifier of [
      `nobody-${tag}@bodhira.test`,
      ` ${u.email!.toUpperCase()} `,
    ]) {
      let last: request.Response | undefined;
      for (let i = 0; i < 11; i++) {
        last = await http()
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', `10.4.${bodies.length}.${i + 1}`)
          .send({ identifier, password: 'wrong-password' });
        if (i < 10) expect(last.status).toBe(422);
      }
      expect(last!.status).toBe(429);
      bodies.push(last!.body);
    }
    expect(bodies[0]).toEqual(bodies[1]);
  }, 60_000); // 22 bcrypt compares

  it('rate-limits uploads per user before the file is buffered', async () => {
    const u = await mkUser('student');
    const t = await tokenFor(u);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await http()
        .post('/api/v1/me/profile')
        .set(bearer(t))
        .attach('avatar', Buffer.from('x'), 'a.png');
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).includes(429)).toBe(false);
    expect(statuses[10]).toBe(429);
  });

  describe('admin and teacher actions', () => {
    it('an admin cannot edit or toggle a peer admin (403), but can edit themselves', async () => {
      const admin = await mkUser('admin');
      const peer = await mkUser('admin');
      const t = await tokenFor(admin);
      await http()
        .patch(`/api/v1/admin/users/${peer.id}`)
        .set(bearer(t))
        .send({ name: 'Hijacked', role: 'admin', password: 'newpass123' })
        .expect(403);
      await http()
        .post(`/api/v1/admin/users/${peer.id}/toggle`)
        .set(bearer(t))
        .expect(403);
      const after = await db.query.users.findFirst({
        where: eq(users.id, peer.id),
      });
      expect(after?.name).toBe(peer.name);
      expect(after?.status).toBe('active');
      await http()
        .patch(`/api/v1/admin/users/${admin.id}`)
        .set(bearer(t))
        .send({ name: 'Me', role: 'admin' })
        .expect(200);
    });

    it('an admin setting a password revokes the account tokens', async () => {
      const admin = await mkUser('admin');
      const student = await mkUser('student');
      await tokenFor(student);
      await tokenFor(student);
      expect(await tokenCount(student)).toBe(2);
      await http()
        .patch(`/api/v1/admin/users/${student.id}`)
        .set(bearer(await tokenFor(admin)))
        .send({ name: student.name, role: 'student', password: 'newpass123' })
        .expect(200);
      expect(await tokenCount(student)).toBe(0);
    });

    it('a teacher setting a student password revokes the tokens', async () => {
      const student = await mkUser('student');
      await tokenFor(student);
      await app
        .get(RosterService)
        .updateStudent({ id: 0n } as classes, student, {
          name: student.name,
          email: student.email,
          phone: null,
          gender: null,
          dob: null,
          password: 'newpass123',
          roll_no: null,
        });
      expect(await tokenCount(student)).toBe(0);
    });

    it('blocking or deactivating ends open video sessions, tokens too', async () => {
      const admin = await mkUser('admin');
      const t = await tokenFor(admin);
      const roster = app.get(RosterService);
      const open = async (u: User) => {
        const now = new Date();
        const id = randomBytes(16).toString('hex');
        await db.insert(video_sessions).values({
          id,
          user_id: u.id,
          lesson_id: 1n,
          user_agent: 'jest',
          created_at: now,
          key_deadline: new Date(now.getTime() + 60_000),
          segments_until: new Date(now.getTime() + 3_600_000),
        });
        return id;
      };
      const revoked = async (id: string) =>
        (await db.query.video_sessions.findFirst({
          where: eq(video_sessions.id, id),
        }))!.revoked_at;

      const a = await mkUser('student');
      const sa = await open(a);
      await http()
        .post(`/api/v1/admin/users/${a.id}/toggle`)
        .set(bearer(t))
        .expect(200);
      expect(await revoked(sa)).toBeInstanceOf(Date);

      const b = await mkUser('student');
      const sb = await open(b);
      await roster.setStatus(b, 'blocked');
      expect(await revoked(sb)).toBeInstanceOf(Date);

      // Staying active leaves sessions alone.
      const c = await mkUser('student');
      const sc = await open(c);
      await roster.setStatus(c, 'active');
      expect(await revoked(sc)).toBeNull();
    });
  });
});
