process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  chapters,
  lessons,
  personal_access_tokens,
  school_syllabus,
  schools,
  subjects,
  subscriptions,
  syllabi,
  users,
} from '../src/db/schema';
import type { schools as School, users as User } from '../src/db/types';

loadEnv();

const tag = randomBytes(3).toString('hex');
const VDO_SECRET = `stub-${tag}`;
const hex32 = () => randomBytes(16).toString('hex');
const USER_MORPH = 'App\\Models\\User';

/**
 * not in legacy: Bodhira Direct, the default school (2026-11-01). Self sign-up
 * students join it and keep the individual (B2C) rules; its guards; school
 * admins' read-only subjects, `GET /admin/content` and lesson playback.
 * VdoCipher is a local stub. Creates its own schools, syllabi, content and
 * users (removed afterwards); Bodhira Direct comes from migration 0007.
 */
describe('Bodhira Direct and school content (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let tokens: TokenService;
  let stub: Server;
  let direct: School;
  const otpBodies: string[] = [];
  const envBefore: Record<string, string | undefined> = {};
  const createdUsers: bigint[] = [];
  const createdSchools: bigint[] = [];
  const createdSyllabi: bigint[] = [];
  const createdSubjects: bigint[] = [];
  const http = () => request(app.getHttpServer());
  const t: Record<string, string> = {};
  const u: Record<string, User> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const now = new Date();
  const stamps = { created_at: now, updated_at: now };

  let n = 0;
  async function mkUser(
    who: string,
    role: string,
    extra: Partial<typeof users.$inferInsert> = {},
  ) {
    n += 1;
    const [user] = await db
      .insert(users)
      .values({
        name: `Direct ${who} ${n}`,
        email: `direct-${tag}-${n}@bodhira.test`,
        password: 'x',
        role,
        status: 'active',
        ...stamps,
        ...extra,
      })
      .returning();
    createdUsers.push(user.id);
    u[who] = user;
    t[who] = await tokens.issue(user, 'e2e', [`role:${role}`]);
    return user;
  }

  async function mkSchool(name: string) {
    const [s] = await db
      .insert(schools)
      .values({
        name: `${name} ${tag}`,
        slug: `${name.toLowerCase()}-${tag}`,
        code: `DS${name.slice(0, 2).toUpperCase()}${tag.toUpperCase()}`,
        ...stamps,
      })
      .returning();
    createdSchools.push(s.id);
    return s;
  }

  async function mkSyllabus(grade: string) {
    const [s] = await db
      .insert(syllabi)
      .values({
        board: `E2E${tag}`,
        grade,
        name: `E2E ${tag} ${grade}`,
        slug: `e2e-${tag}-${grade.toLowerCase()}`,
        ...stamps,
      })
      .returning();
    createdSyllabi.push(s.id);
    return s;
  }

  /** A platform subject with one published chapter: a video lesson and an unpublished one. */
  async function mkSubject(
    name: string,
    syllabusId: bigint | null,
    schoolId: bigint | null = null,
  ) {
    const [subject] = await db
      .insert(subjects)
      .values({
        school_id: schoolId,
        syllabus_id: syllabusId,
        name: `${name} ${tag}`,
        slug: `${name.toLowerCase()}-${tag}`,
        ...stamps,
      })
      .returning();
    createdSubjects.push(subject.id);
    const [chapter] = await db
      .insert(chapters)
      .values({
        subject_id: subject.id,
        title: `${name} chapter`,
        slug: `${name.toLowerCase()}-ch-${tag}`,
        ...stamps,
      })
      .returning();
    const [video] = await db
      .insert(lessons)
      .values({
        chapter_id: chapter.id,
        title: `${name} video`,
        slug: `${name.toLowerCase()}-v-${tag}`,
        type: 'video',
        video_id: hex32(),
        duration_sec: 90,
        ...stamps,
      })
      .returning();
    const [hidden] = await db
      .insert(lessons)
      .values({
        chapter_id: chapter.id,
        title: `${name} draft`,
        slug: `${name.toLowerCase()}-d-${tag}`,
        type: 'video',
        video_id: hex32(),
        is_published: false,
        ...stamps,
      })
      .returning();
    return { subject, chapter, video, hidden };
  }

  const trial = (userId: bigint, days: number) =>
    db.insert(subscriptions).values({
      subscribable_type: USER_MORPH,
      subscribable_id: userId,
      plan: 'trial',
      status: 'trialing',
      trial_ends_at: new Date(now.getTime() + days * 86_400_000),
      ...stamps,
    });

  let sylX: bigint;
  let sylY: bigint;
  let subX: Awaited<ReturnType<typeof mkSubject>>;
  let subY: Awaited<ReturnType<typeof mkSubject>>;
  let own: Awaited<ReturnType<typeof mkSubject>>;
  let schoolA: School;
  let schoolB: School;

  beforeAll(async () => {
    stub = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (/^\/videos\/[a-f0-9]{32}\/otp$/.test(req.url ?? '')) {
          otpBodies.push(Buffer.concat(chunks).toString('utf8'));
          return res.end(JSON.stringify({ otp: 'otp', playbackInfo: 'pbi' }));
        }
        res.end('{}');
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    setEnv('VDOCIPHER_API_SECRET', VDO_SECRET);
    setEnv(
      'VDOCIPHER_API_BASE',
      `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    tokens = app.get(TokenService);

    const row = await db.query.schools.findFirst({
      where: eq(schools.is_direct, true),
    });
    if (!row)
      throw new Error('Bodhira Direct is missing: run npm run db:migrate');
    direct = row;

    sylX = (await mkSyllabus('X')).id;
    sylY = (await mkSyllabus('Y')).id;
    subX = await mkSubject('Xsub', sylX);
    subY = await mkSubject('Ysub', sylY);
    schoolA = await mkSchool('Alpha');
    schoolB = await mkSchool('Beta');
    own = await mkSubject('Own', null, schoolA.id);
    // Alpha uses syllabus X, Beta uses Y (opt-ins).
    await db.insert(school_syllabus).values([
      { school_id: schoolA.id, syllabus_id: sylX, ...stamps },
      { school_id: schoolB.id, syllabus_id: sylY, ...stamps },
    ]);

    await mkUser('adminA', 'admin', { school_id: schoolA.id });
    await mkUser('adminB', 'admin', { school_id: schoolB.id });
    await mkUser('super', 'super_admin');
    await mkUser('studentA', 'student', { school_id: schoolA.id, grade: '9' });
    // Twins: one as legacy left B2C students (no school), one moved to Bodhira Direct.
    for (const [who, school] of [
      ['b2c', null],
      ['moved', direct.id],
    ] as const) {
      await mkUser(who, 'student', {
        school_id: school,
        syllabus_id: sylX,
        grade: '9',
      });
      await trial(u[who].id, 5);
    }
    await mkUser('movedLapsed', 'student', {
      school_id: direct.id,
      syllabus_id: sylX,
      grade: '9',
    });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (db) {
      if (createdUsers.length) {
        await db
          .delete(personal_access_tokens)
          .where(inArray(personal_access_tokens.tokenable_id, createdUsers));
        await db
          .delete(subscriptions)
          .where(
            and(
              eq(subscriptions.subscribable_type, USER_MORPH),
              inArray(subscriptions.subscribable_id, createdUsers),
            ),
          );
        await db.delete(users).where(inArray(users.id, createdUsers));
      }
      // chapters and lessons cascade from the subject
      if (createdSubjects.length)
        await db.delete(subjects).where(inArray(subjects.id, createdSubjects));
      if (createdSchools.length) {
        await db
          .delete(school_syllabus)
          .where(inArray(school_syllabus.school_id, createdSchools));
        await db.delete(schools).where(inArray(schools.id, createdSchools));
      }
      if (createdSyllabi.length)
        await db.delete(syllabi).where(inArray(syllabi.id, createdSyllabi));
    }
    await app?.close();
    await new Promise((r) => stub?.close(r));
  });

  /** Signed-in user for a token created by the API (sign-up). */
  const adopt = async (
    who: string,
    body: { data: { token: string; user: { id: number } } },
  ) => {
    createdUsers.push(BigInt(body.data.user.id));
    t[who] = body.data.token;
    const row = await db.query.users.findFirst({
      where: eq(users.id, BigInt(body.data.user.id)),
    });
    u[who] = row!;
  };

  describe('sign-up', () => {
    it('puts a self sign-up student in Bodhira Direct with the trial, paywall and checkout', async () => {
      const res = await http()
        .post('/api/v1/auth/register/student')
        .send({
          name: 'Direct Signup',
          email: `direct-signup-${tag}@bodhira.test`,
          password: 'secret123',
          password_confirmation: 'secret123',
          syllabus_id: Number(sylX),
          plan_key: 'individual_premium',
          cycle: 'yearly',
          accept: '1',
        })
        .expect(201);
      await adopt('signup', res.body);
      expect(u.signup.school_id).toBe(direct.id);
      // Released apps read `school: null` as an individual student.
      expect(res.body.data.user.school).toBeNull();
      expect(res.body.data.user).not.toHaveProperty('organization');
      const subId = res.body.data.checkout.subscription_id as number;

      const access = await http()
        .get('/api/v1/student/access')
        .set(as('signup'));
      expect(access.body.data).toEqual({ has_access: true });
      const paywall = await http()
        .get('/api/v1/billing/paywall')
        .set(as('signup'))
        .expect(200);
      expect(paywall.body.data.subscription.status).toBe('trialing');
      const checkout = await http()
        .get(`/api/v1/billing/checkout/${subId}`)
        .set(as('signup'))
        .expect(200);
      expect(checkout.body.data.plan.key).toBe('individual_premium');
      const subjectsRes = await http()
        .get('/api/v1/student/subjects')
        .set(as('signup'))
        .expect(200);
      expect(subjectsRes.body.data.map((s: { id: number }) => s.id)).toContain(
        Number(subX.subject.id),
      );
    });

    it('puts a student registering without a school code in Bodhira Direct', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .send({
          name: 'Direct Plain',
          email: `direct-plain-${tag}@bodhira.test`,
          password: 'secret123',
          password_confirmation: 'secret123',
          role: 'student',
        })
        .expect(201);
      await adopt('plain', res.body);
      expect(u.plain.school_id).toBe(direct.id);
      expect(res.body.data.user.school).toBeNull();
      // No subscription: the paywall applies, like a legacy B2C student.
      await http().get('/api/v1/student/subjects').set(as('plain')).expect(402);
    });
  });

  describe('a moved student', () => {
    const strip = (body: { data: Record<string, unknown> }) => {
      const { student, ...rest } = body.data as {
        student: Record<string, unknown>;
      };
      const s = { ...student };
      delete s.id;
      delete s.name;
      return { student: s, ...rest };
    };

    it('sees the same home, subjects and profile as a student with no school', async () => {
      for (const path of ['/student/home', '/student/subjects']) {
        const [a, b] = await Promise.all(
          ['b2c', 'moved'].map((w) =>
            http().get(`/api/v1${path}`).set(as(w)).expect(200),
          ),
        );
        if (path === '/student/home') {
          expect(strip(b.body)).toEqual(strip(a.body));
          expect(b.body.data.student.school).toBeNull();
        } else expect(b.body).toEqual(a.body);
      }
      const profile = await http()
        .get('/api/v1/student/profile')
        .set(as('moved'))
        .expect(200);
      expect(profile.body.data.student.school).toBeNull();
      expect(profile.body.data.is_individual).toBe(true);
    });

    it('is stopped by the paywall without a subscription (402)', async () => {
      const res = await http()
        .get('/api/v1/student/subjects')
        .set(as('movedLapsed'))
        .expect(402);
      expect(res.body.code).toBe('subscription_inactive');
      // The individual paywall checkout is open to them (demo mode here).
      await http()
        .post('/api/v1/billing/paywall/checkout')
        .set(as('movedLapsed'))
        .send({ plan: 'individual_basic', cycle: 'monthly' })
        .expect(201);
      await http()
        .get('/api/v1/student/subjects')
        .set(as('movedLapsed'))
        .expect(200);
    });

    it('keeps the user resource: school null, no organization field', async () => {
      const me = await http()
        .get('/api/v1/auth/me')
        .set(as('moved'))
        .expect(200);
      expect(me.body.data.school).toBeNull();
      expect(me.body.data).not.toHaveProperty('organization');
      const other = await http()
        .get('/api/v1/auth/me')
        .set(as('studentA'))
        .expect(200);
      expect(other.body.data.school).toEqual(
        expect.objectContaining({ id: Number(schoolA.id), code: schoolA.code }),
      );
      const admin = await http()
        .get('/api/v1/auth/me')
        .set(as('adminA'))
        .expect(200);
      expect(admin.body.data.role_label).toBe('School Admin');
    });

    it('is managed by the super admin through /admin', async () => {
      const list = await http()
        .get(`/api/v1/admin/users?q=${encodeURIComponent(u.moved.email!)}`)
        .set(as('super'))
        .expect(200);
      expect(list.body.data.map((r: { id: number }) => r.id)).toEqual([
        Number(u.moved.id),
      ]);
      await http()
        .get(`/api/v1/admin/users/${u.moved.id}`)
        .set(as('super'))
        .expect(200);
      // Another school's admin can't.
      await http()
        .get(`/api/v1/admin/users/${u.moved.id}`)
        .set(as('adminA'))
        .expect(403);
      const created = await http()
        .post('/api/v1/admin/users')
        .set(as('super'))
        .send({
          name: 'Super Added',
          email: `direct-added-${tag}@bodhira.test`,
          role: 'student',
          password: 'secret123',
        })
        .expect(201);
      createdUsers.push(BigInt(created.body.data.id as number));
      const row = await db.query.users.findFirst({
        where: eq(users.id, BigInt(created.body.data.id as number)),
      });
      expect(row?.school_id).toBe(direct.id);
    });
  });

  describe('Bodhira Direct guards', () => {
    const blocked = (what: string) => ({
      success: false,
      code: 'direct_school',
      message: `Bodhira Direct (the default school) can't ${what}.`,
    });

    it('lists and shows it with is_direct', async () => {
      const list = await http()
        .get('/api/v1/super/schools?q=BODHIRA-DIRECT')
        .set(as('super'))
        .expect(200);
      expect(list.body.data).toEqual([
        expect.objectContaining({ id: Number(direct.id), is_direct: true }),
      ]);
      const other = await http()
        .get(`/api/v1/super/schools?q=${schoolA.code}`)
        .set(as('super'))
        .expect(200);
      expect(other.body.data[0].is_direct).toBe(false);
      const show = await http()
        .get(`/api/v1/super/schools/${direct.id}`)
        .set(as('super'))
        .expect(200);
      expect(show.body.data.school.is_direct).toBe(true);
    });

    it('refuses deactivation, school billing and seat caps (422)', async () => {
      const toggle = await http()
        .post(`/api/v1/super/schools/${direct.id}/toggle`)
        .set(as('super'))
        .expect(422);
      expect(toggle.body).toEqual(blocked('be deactivated'));
      const plan = await http()
        .patch(`/api/v1/super/schools/${direct.id}`)
        .set(as('super'))
        .send({ name: direct.name, plan: 'pro' })
        .expect(422);
      expect(plan.body).toEqual(blocked('be billed as a school'));
      const seats = await http()
        .post(`/api/v1/super/schools/${direct.id}/web`)
        .set(as('super'))
        .field('name', direct.name)
        .field('max_students', '50')
        .expect(422);
      expect(seats.body).toEqual(blocked('have seat caps'));
      const grant = await http()
        .post(`/api/v1/super/billing/schools/${direct.id}/grant`)
        .set(as('super'))
        .send({ plan: 'pro', days: 30, amount_paise: 0 })
        .expect(422);
      expect(grant.body).toEqual(blocked('be billed as a school'));
      // Saving the form with its current values still works.
      await http()
        .patch(`/api/v1/super/schools/${direct.id}`)
        .set(as('super'))
        .send({ name: direct.name, plan: 'free' })
        .expect(200);
      const after = await db.query.schools.findFirst({
        where: eq(schools.id, direct.id),
      });
      expect(after).toEqual(
        expect.objectContaining({
          status: 'active',
          plan: 'free',
          plan_expires_at: null,
          max_students: direct.max_students,
        }),
      );
    });

    it('leaves it out of the platform school figures', async () => {
      const home = await http()
        .get('/api/v1/super/home')
        .set(as('super'))
        .expect(200);
      expect(
        home.body.data.top_schools.map((s: { id: number }) => s.id),
      ).not.toContain(Number(direct.id));
      const revenue = await http()
        .get('/api/v1/super/revenue')
        .set(as('super'))
        .expect(200);
      const byPlan = revenue.body.data.by_plan as { count: number }[];
      const billed = await db.$count(
        schools,
        and(eq(schools.is_direct, false), isNull(schools.deleted_at)),
      );
      expect(byPlan.reduce((n, p) => n + p.count, 0)).toBe(billed);
    });
  });

  describe('school admin content', () => {
    it('answers 403 to subject writes', async () => {
      const msg = {
        success: false,
        message: "Subjects come from the Super Admin's curricula.",
      };
      const id = own.subject.id;
      const writes = [
        () => http().post('/api/v1/admin/subjects').send({ name: 'New' }),
        () =>
          http()
            .patch(`/api/v1/admin/subjects/${id}`)
            .send({ name: 'Renamed' }),
        () => http().delete(`/api/v1/admin/subjects/${id}`),
      ];
      for (const write of writes)
        expect((await write().set(as('adminA')).expect(403)).body).toEqual(msg);
      const still = await db.query.subjects.findFirst({
        where: eq(subjects.id, id),
      });
      expect(still?.name).toBe(own.subject.name);
      // The list stays.
      const list = await http()
        .get('/api/v1/admin/subjects')
        .set(as('adminA'))
        .expect(200);
      expect(list.body.data.map((s: { id: number }) => s.id)).toContain(
        Number(id),
      );
    });

    it('lists the curricula the school uses, published content only', async () => {
      const res = await http()
        .get('/api/v1/admin/content')
        .set(as('adminA'))
        .expect(200);
      const ids = res.body.data.syllabi.map((s: { id: number | null }) => s.id);
      expect(ids).toContain(Number(sylX));
      expect(ids).not.toContain(Number(sylY));
      const x = res.body.data.syllabi.find(
        (s: { id: number }) => s.id === Number(sylX),
      );
      expect(x).toEqual({
        id: Number(sylX),
        name: `E2E ${tag} X`,
        subjects: [
          {
            id: Number(subX.subject.id),
            name: subX.subject.name,
            grade: null,
            chapters: [
              {
                id: Number(subX.chapter.id),
                title: subX.chapter.title,
                lessons: [
                  {
                    id: Number(subX.video.id),
                    title: subX.video.title,
                    type: 'video',
                    duration_sec: 90,
                    playback: 'vdocipher',
                    thumbnail: null,
                  },
                ],
              },
            ],
          },
        ],
      });
      // The school's own subjects (no syllabus) come last.
      const last = res.body.data.syllabi.at(-1);
      expect(last.id).toBeNull();
      expect(last.name).toBe(schoolA.name);
      expect(last.subjects.map((s: { id: number }) => s.id)).toEqual([
        Number(own.subject.id),
      ]);

      const b = await http()
        .get('/api/v1/admin/content')
        .set(as('adminB'))
        .expect(200);
      const bIds = b.body.data.syllabi.map((s: { id: number | null }) => s.id);
      expect(bIds).toContain(Number(sylY));
      expect(bIds).not.toContain(Number(sylX));
      expect(JSON.stringify(b.body)).not.toContain(own.subject.name);
    });

    it('gives the super admin Bodhira Direct’s curricula', async () => {
      const res = await http()
        .get('/api/v1/admin/content')
        .set(as('super'))
        .expect(200);
      // The moved students are on syllabus X.
      expect(
        res.body.data.syllabi.map((s: { id: number | null }) => s.id),
      ).toContain(Number(sylX));
    });

    it('lets an admin play lessons of a used curriculum, watermarked', async () => {
      otpBodies.length = 0;
      const res = await http()
        .get(`/api/v1/lessons/${subX.video.id}/playback`)
        .set(as('adminA'))
        .expect(200);
      expect(res.body.data.provider).toBe('vdocipher');
      const annotate = JSON.parse(
        (JSON.parse(otpBodies[0]) as { annotate: string }).annotate,
      ) as { text: string }[];
      expect(annotate[0].text).toBe(`${u.adminA.name} · ${u.adminA.email}`);
      await http()
        .get(`/api/v1/lessons/${own.video.id}/playback`)
        .set(as('adminA'))
        .expect(200);
      await http()
        .get(`/api/v1/lessons/${subY.video.id}/playback`)
        .set(as('adminB'))
        .expect(200);
    });

    it('refuses other curricula, other schools’ subjects and drafts (403)', async () => {
      const cant = { success: false, message: "You can't play this lesson." };
      for (const [who, lesson] of [
        ['adminA', subY.video.id],
        ['adminA', subX.hidden.id],
        ['adminB', subX.video.id],
        ['adminB', own.video.id],
        ['super', subX.video.id],
      ] as const) {
        const res = await http()
          .get(`/api/v1/lessons/${lesson}/playback`)
          .set(as(who))
          .expect(403);
        expect(res.body).toEqual(cant);
      }
    });
  });
});
