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
import {
  ai_chat_sessions,
  assignments,
  chapters,
  class_student,
  class_subject,
  classes,
  faqs,
  invoices,
  lessons,
  live_classes,
  parent_student,
  personal_access_tokens,
  plans,
  quizzes,
  schools,
  services,
  subjects,
  subscriptions,
  syllabi,
  users,
} from '../src/db/schema';
import type { users as User } from '../src/db/types';

loadEnv();

const tag = randomBytes(3).toString('hex');
const BASE62 = /^[A-Za-z][A-Za-z0-9]{11}$/;

/**
 * Not in legacy (docs/slug-contract.md): every entity ID in a URL can be the numeric id (mobile
 * app), the slug or the public_id. Builds its own school and removes every row it made.
 */
describe('Slugs and public ids (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  const createdUsers: bigint[] = [];
  const t: Record<string, string> = {};
  const u: Record<string, User> = {};
  let schoolId: bigint;
  let otherSchoolId: bigint;
  let syllabusId: bigint;
  const planIds: bigint[] = [];
  const serviceIds: bigint[] = [];
  const faqIds: bigint[] = [];
  const subjectIds: bigint[] = [];
  const classIds: bigint[] = [];
  const quizIds: bigint[] = [];
  const e = {} as Record<string, any>;

  const http = () => request(app.getHttpServer());
  const api = (who: string, path: string) =>
    http()
      .get(`/api/v1${path}`)
      .set({ Authorization: `Bearer ${t[who]}` });
  const post = (who: string, path: string, body: object = {}) =>
    http()
      .post(`/api/v1${path}`)
      .set({ Authorization: `Bearer ${t[who]}` })
      .send(body);

  /** The same request by id and by slug / public_id answers the same. */
  async function same(
    who: string,
    path: (ref: string) => string,
    id: unknown,
    ref: string,
    status = 200,
  ) {
    const byId = await api(who, path(String(id)));
    const byRef = await api(who, path(ref));
    expect(byId.status).toBe(status);
    expect(byRef.status).toBe(status);
    if (status !== 200) expect(byRef.body.message).toBe(byId.body.message);
    return byRef.body as Record<string, any>;
  }

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
    const now = new Date();

    const mkSchool = async (name: string) => {
      const [s] = await db
        .insert(schools)
        .values({
          name: `${name} ${tag}`,
          slug: `${name.toLowerCase()}-${tag}`,
          code: `${name.slice(0, 2).toUpperCase()}${tag.toUpperCase()}`,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return s;
    };
    const school = await mkSchool('Slugs');
    const other = await mkSchool('Foreign');
    schoolId = school.id;
    otherSchoolId = other.id;

    for (const [who, role, sid] of [
      ['teacher', 'teacher', school.id],
      ['teacher2', 'teacher', school.id],
      ['s1', 'student', school.id],
      ['s2', 'student', other.id],
      ['parent', 'parent', school.id],
      ['parent2', 'parent', school.id],
      ['admin', 'admin', school.id],
      ['super', 'super_admin', null],
      ['web', 'web_admin', null],
    ] as const) {
      const [user] = await db
        .insert(users)
        .values({
          name: `Slug ${who} ${tag}`,
          email: `slug-${tag}-${who}@bodhira.test`,
          password: 'x',
          role,
          status: 'active',
          school_id: sid,
          created_at: now,
          updated_at: now,
        })
        .returning();
      createdUsers.push(user.id);
      u[who] = user;
      t[who] = await tokens.issue(user, 'e2e', [`role:${role}`]);
    }

    const [syl] = await db
      .insert(syllabi)
      .values({
        board: `B${tag}`,
        grade: '7',
        name: `Syllabus ${tag}`,
        slug: `syllabus-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    syllabusId = syl.id;

    const [subject] = await db
      .insert(subjects)
      .values({
        school_id: school.id,
        name: `Physics ${tag}`,
        slug: `physics-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [chapter] = await db
      .insert(chapters)
      .values({
        subject_id: subject.id,
        title: `Motion ${tag}`,
        slug: `motion-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [lesson] = await db
      .insert(lessons)
      .values({
        chapter_id: chapter.id,
        title: `Speed ${tag}`,
        slug: `speed-${tag}`,
        type: 'text',
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [klass] = await db
      .insert(classes)
      .values({
        school_id: school.id,
        grade: '7',
        section: `S${tag}`,
        class_teacher_id: u.teacher.id,
        created_at: now,
        updated_at: now,
      })
      .returning();
    await db.insert(class_subject).values({
      class_id: klass.id,
      subject_id: subject.id,
      teacher_id: u.teacher.id,
    });
    await db
      .insert(class_student)
      .values({ class_id: klass.id, student_id: u.s1.id, roll_no: '1' });
    await db.insert(parent_student).values({
      parent_id: u.parent.id,
      student_id: u.s1.id,
      relation: 'mother',
    });
    const [quiz] = await db
      .insert(quizzes)
      .values({
        school_id: school.id,
        subject_id: subject.id,
        created_by: u.teacher.id,
        title: `Forces ${tag}`,
        is_published: true,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [asg] = await db
      .insert(assignments)
      .values({
        class_id: klass.id,
        subject_id: subject.id,
        teacher_id: u.teacher.id,
        title: `Worksheet ${tag}`,
        max_marks: 10,
        is_published: true,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [live] = await db
      .insert(live_classes)
      .values({
        host_id: u.teacher.id,
        school_id: school.id,
        class_id: klass.id,
        title: `Doubt session ${tag}`,
        scheduled_at: new Date(Date.now() + 3600_000),
        duration_min: 30,
        provider: 'jitsi',
        status: 'scheduled',
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [plan] = await db
      .insert(plans)
      .values({
        key: `slug_${tag}`,
        audience: 'school',
        name: `Gold ${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [sub] = await db
      .insert(subscriptions)
      .values({
        subscribable_type: 'App\\Models\\User',
        subscribable_id: u.s1.id,
        plan: 'individual_premium',
        status: 'active',
        meta: JSON.stringify({ cycle: 'monthly' }),
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [inv] = await db
      .insert(invoices)
      .values({
        number: `SLUG-${tag}`,
        user_id: u.s1.id,
        plan_key: 'individual_premium',
        plan_name: 'Premium',
        amount_paise: 100n,
        total_paise: 118n,
        status: 'paid',
        issued_at: now,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [ai] = await db
      .insert(ai_chat_sessions)
      .values({
        user_id: u.s1.id,
        title: 'Help',
        mode: 'tutor',
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [svc] = await db
      .insert(services)
      .values({
        title: `Service ${tag}`,
        slug: `service-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [faq] = await db
      .insert(faqs)
      .values({
        question: `Why ${tag}?`,
        answer: 'Because.',
        created_at: now,
        updated_at: now,
      })
      .returning();
    Object.assign(e, {
      subject,
      chapter,
      lesson,
      klass,
      quiz,
      asg,
      live,
      plan,
      sub,
      inv,
      ai,
      svc,
      faq,
      syl,
    });
    subjectIds.push(subject.id);
    classIds.push(klass.id);
    quizIds.push(quiz.id);
    planIds.push(plan.id);
    serviceIds.push(svc.id);
    faqIds.push(faq.id);
  });

  afterAll(async () => {
    if (db && createdUsers.length) {
      await db
        .delete(personal_access_tokens)
        .where(inArray(personal_access_tokens.tokenable_id, createdUsers));
      for (const sid of [schoolId, otherSchoolId]) {
        if (!sid) continue;
        await db.delete(quizzes).where(eq(quizzes.school_id, sid));
        await db.delete(classes).where(eq(classes.school_id, sid));
        await db.delete(subjects).where(eq(subjects.school_id, sid));
      }
      // subjects/classes created through the API by the super admin or the admin
      await db
        .delete(subscriptions)
        .where(eq(subscriptions.subscribable_id, u.s1.id));
      await db.delete(invoices).where(eq(invoices.user_id, u.s1.id));
      await db.delete(live_classes).where(eq(live_classes.school_id, schoolId));
      if (quizIds.length)
        await db.delete(quizzes).where(inArray(quizzes.id, quizIds));
      if (subjectIds.length)
        await db.delete(subjects).where(inArray(subjects.id, subjectIds));
      if (planIds.length)
        await db.delete(plans).where(inArray(plans.id, planIds));
      if (serviceIds.length)
        await db.delete(services).where(inArray(services.id, serviceIds));
      if (faqIds.length) await db.delete(faqs).where(inArray(faqs.id, faqIds));
      await db.delete(users).where(inArray(users.id, createdUsers));
      if (syllabusId)
        await db.delete(syllabi).where(eq(syllabi.id, syllabusId));
      for (const sid of [schoolId, otherSchoolId])
        if (sid) await db.delete(schools).where(eq(schools.id, sid));
    }
    await app?.close();
  });

  // ── Slugs and public ids exist (backfill / insert fallback) ──

  it('gives every new row a slug or a public id', () => {
    expect(e.subject.url_slug).toBe(`physics-${tag}`);
    expect(e.chapter.url_slug).toBe(`motion-${tag}`);
    expect(e.lesson.url_slug).toBe(`speed-${tag}`);
    expect(e.klass.slug).toBe(`class-7-s${tag}`);
    expect(e.quiz.slug).toBe(`forces-${tag}`);
    expect(e.asg.slug).toBe(`worksheet-${tag}`);
    expect(e.live.slug).toBe(`doubt-session-${tag}`);
    expect(e.plan.slug).toBe(`gold-${tag}`);
    for (const row of [u.s1, e.sub, e.inv, e.ai, e.faq])
      expect(row.public_id).toMatch(BASE62);
  });

  // ── Fetch by slug / public_id: one route per entity ──

  it('subjects, chapters, lessons, quizzes (student)', async () => {
    const sub = await same(
      's1',
      (r) => `/student/subjects/${r}`,
      e.subject.id,
      e.subject.url_slug,
    );
    expect(sub.data.subject).toEqual(
      expect.objectContaining({
        id: Number(e.subject.id),
        url_slug: e.subject.url_slug,
      }),
    );
    expect(sub.data.chapters[0].url_slug).toBe(e.chapter.url_slug);
    const ch = await same(
      's1',
      (r) => `/student/chapters/${r}/lessons`,
      e.chapter.id,
      e.chapter.url_slug,
    );
    expect(ch.data.chapter).toEqual(
      expect.objectContaining({
        url_slug: e.chapter.url_slug,
        subject_slug: e.subject.url_slug,
      }),
    );
    const ls = await same(
      's1',
      (r) => `/student/lessons/${r}`,
      e.lesson.id,
      e.lesson.url_slug,
    );
    expect(ls.data.lesson.chapter).toEqual(
      expect.objectContaining({ url_slug: e.chapter.url_slug }),
    );
    expect(ls.data.lesson.chapter.subject.url_slug).toBe(e.subject.url_slug);
    const qz = await same(
      's1',
      (r) => `/student/quizzes/${r}`,
      e.quiz.id,
      e.quiz.slug,
    );
    expect(qz.body?.data ?? qz.data).toEqual(
      expect.objectContaining({ slug: e.quiz.slug }),
    );
  });

  it('quiz attempts by public_id', async () => {
    const start = await post(
      's1',
      `/student/quizzes/${e.quiz.slug}/start`,
    ).expect(200);
    const { id, public_id } = start.body.data.attempt;
    expect(public_id).toMatch(BASE62);
    const body = await same(
      's1',
      (r) => `/student/attempts/${r}`,
      id,
      public_id,
    );
    expect(body.data.public_id).toBe(public_id);
  });

  it('assignments, live classes, classes (teacher and student)', async () => {
    const a = await same(
      's1',
      (r) => `/student/assignments/${r}`,
      e.asg.id,
      e.asg.slug,
    );
    expect(a.data.assignment.slug).toBe(e.asg.slug);
    await same(
      'teacher',
      (r) => `/teacher/assignments/${r}`,
      e.asg.id,
      e.asg.slug,
    );
    const l = await same(
      'teacher',
      (r) => `/teacher/live-classes/${r}`,
      e.live.id,
      e.live.slug,
    );
    expect(l.data.slug).toBe(e.live.slug);
    const c = await same(
      'teacher',
      (r) => `/teacher/classes/${r}`,
      e.klass.id,
      e.klass.slug,
    );
    expect(c.data.class.slug).toBe(e.klass.slug);
    expect(c.data.class.students[0].public_id).toBe(u.s1.public_id);
    await same('admin', (r) => `/admin/classes/${r}`, e.klass.id, e.klass.slug);
  });

  it('users by public_id (teacher, parent, admin)', async () => {
    const s = await same(
      'teacher',
      (r) => `/teacher/students/${r}`,
      u.s1.id,
      u.s1.public_id,
    );
    expect(s.data.student.public_id).toBe(u.s1.public_id);
    await same(
      'parent',
      (r) => `/parent/children/${r}`,
      u.s1.id,
      u.s1.public_id,
    );
    const a = await same(
      'admin',
      (r) => `/admin/users/${r}`,
      u.s1.id,
      u.s1.public_id,
    );
    expect(a.data.public_id).toBe(u.s1.public_id);
  });

  it('schools, syllabi, plans (super admin)', async () => {
    const sc = await same(
      'super',
      (r) => `/super/schools/${r}`,
      schoolId,
      `slugs-${tag}`,
    );
    expect(sc.data.school.slug).toBe(`slugs-${tag}`);
    const sy = await same(
      'super',
      (r) => `/super/syllabi/${r}`,
      e.syl.id,
      e.syl.slug,
    );
    expect(sy.data.syllabus.slug).toBe(e.syl.slug);
    const p = await same(
      'super',
      (r) => `/super/plans/${r}`,
      e.plan.id,
      e.plan.slug,
    );
    expect(p.data.slug).toBe(e.plan.slug);
    await same(
      'super',
      (r) => `/super/syllabi/${e.syl.slug}/subjects/${r}`,
      e.subject.id,
      e.subject.url_slug,
      404,
    );
  });

  it('conversations, invoices, subscriptions, AI sessions by public_id', async () => {
    const start = await post(
      'parent',
      `/chat/with-teacher/${u.s1.public_id}`,
    ).expect(200);
    const conv = start.body.data;
    expect(conv.public_id).toMatch(BASE62);
    const chat = await same(
      'parent',
      (r) => `/chat/${r}`,
      conv.id,
      conv.public_id,
    );
    expect(chat.data.conversation.public_id).toBe(conv.public_id);
    const inv = await same(
      's1',
      (r) => `/billing/invoices/${r}`,
      e.inv.id,
      e.inv.public_id,
    );
    expect(inv.data.public_id).toBe(e.inv.public_id);
    const sub = await same(
      's1',
      (r) => `/billing/checkout/${r}`,
      e.sub.id,
      e.sub.public_id,
    );
    expect(sub.data.subscription.public_id).toBe(e.sub.public_id);
    const ai = await same(
      's1',
      (r) => `/student/ai/sessions/${r}`,
      e.ai.id,
      e.ai.public_id,
    );
    expect(ai.data.session.public_id).toBe(e.ai.public_id);
  });

  it('CMS collections: slug (services) and public_id (faqs)', async () => {
    await same('web', (r) => `/cms/services/${r}`, e.svc.id, e.svc.slug);
    const f = await same(
      'web',
      (r) => `/cms/faqs/${r}`,
      e.faq.id,
      e.faq.public_id,
    );
    expect(f.data.row.public_id).toBe(e.faq.public_id);
  });

  // ── 404 and 403 behave as with ids ──

  it('answers 404 for an unknown slug or public id', async () => {
    for (const [who, path] of [
      ['s1', '/student/subjects/no-such-subject'],
      ['s1', '/student/lessons/no-such-lesson'],
      ['s1', '/student/attempts/NoSuchAttempt'],
      ['teacher', '/teacher/classes/no-such-class'],
      ['teacher', '/teacher/students/NoSuchUser12'],
      ['super', '/super/schools/no-such-school'],
      ['parent', '/chat/NoSuchChat123'],
    ]) {
      const res = await api(who, path).expect(404);
      expect(res.body.message).toMatch(/^No query results for model/);
    }
  });

  it('matches slug lookups case-insensitively, public ids exactly', async () => {
    await api(
      's1',
      `/student/subjects/${e.subject.url_slug.toUpperCase()}`,
    ).expect(200);
    await api(
      'teacher',
      `/teacher/students/${u.s1.public_id.toLowerCase()}`,
    ).expect(u.s1.public_id === u.s1.public_id.toLowerCase() ? 200 : 404);
  });

  it('answers 403 for an inaccessible entity by slug exactly as by id', async () => {
    // Another school's student opening this school's subject.
    const sub = await same(
      's2',
      (r) => `/student/subjects/${r}`,
      e.subject.id,
      e.subject.url_slug,
      403,
    );
    expect(sub.message).toBe('Subject not available for your school.');
    await same(
      's2',
      (r) => `/student/lessons/${r}`,
      e.lesson.id,
      e.lesson.url_slug,
      403,
    );
    // A parent that is not linked to the child.
    await same(
      'parent2',
      (r) => `/parent/children/${r}`,
      u.s1.id,
      u.s1.public_id,
      403,
    );
    // A teacher that does not teach the class.
    await same(
      'teacher2',
      (r) => `/teacher/classes/${r}`,
      e.klass.id,
      e.klass.slug,
      403,
    );
    // Someone else's invoice.
    await same(
      's2',
      (r) => `/billing/invoices/${r}`,
      e.inv.id,
      e.inv.public_id,
      403,
    );
    // The wrong role still gets the role error first.
    await same('s1', (r) => `/super/plans/${r}`, e.plan.id, e.plan.slug, 403);
  });

  // ── Creation: unique slugs ──

  it('numbers duplicate titles -2, -3 and never makes an all-digit slug', async () => {
    const create = async (who: string, path: string, body: object) => {
      const res = await post(who, path, body);
      if (res.status >= 300)
        throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.data as Record<string, any>;
    };

    // Teacher assignments.
    const a1 = await create('teacher', '/teacher/assignments', {
      class_id: Number(e.klass.id),
      title: `Dup ${tag}`,
      max_marks: 5,
    });
    const a2 = await create('teacher', '/teacher/assignments', {
      class_id: Number(e.klass.id),
      title: `dup ${tag}`,
      max_marks: 5,
    });
    expect(a1.slug).toBe(`dup-${tag}`);
    expect(a2.slug).toBe(`dup-${tag}-2`);

    // Admin classes.
    const mk = (n: string) =>
      create('admin', '/admin/classes', { grade: '5', section: `${n}${tag}` });
    expect((await mk('x')).slug).toBe(`class-5-x${tag}`);
    expect((await mk('x')).slug).toBe(`class-5-x${tag}-2`);

    // Super admin: plans, syllabus subjects.
    const plan = (key: string) =>
      create('super', '/super/plans', {
        key,
        audience: 'school',
        name: `Dup plan ${tag}`,
        monthly_price: 1,
        yearly_price: 1,
      });
    const p1 = await plan(`dp1_${tag}`);
    const p2 = await plan(`dp2_${tag}`);
    expect(p1.slug).toBe(`dup-plan-${tag}`);
    expect(p2.slug).toBe(`dup-plan-${tag}-2`);
    planIds.push(p1.id, p2.id);
    const subj = () =>
      create('super', `/super/syllabi/${e.syl.slug}/subjects`, {
        name: `Dup subject ${tag}`,
      });
    const s1 = await subj();
    const s2 = await subj();
    expect(s1.url_slug).toBe(`dup-subject-${tag}`);
    expect(s2.url_slug).toBe(`dup-subject-${tag}-2`);
    subjectIds.push(s1.id, s2.id);

    // Content: chapters, lessons, quizzes; an all-digit title gets the entity word.
    const digits = String(Date.now());
    const c1 = await create(
      'super',
      `/content/subjects/${e.subject.id}/chapters`,
      { title: `Dup chapter ${tag}` },
    );
    const c2 = await create(
      'super',
      `/content/subjects/${e.subject.id}/chapters`,
      { title: `Dup chapter ${tag}` },
    );
    const c3 = await create(
      'super',
      `/content/subjects/${e.subject.id}/chapters`,
      { title: digits },
    );
    const c4 = await create(
      'super',
      `/content/subjects/${e.subject.id}/chapters`,
      { title: '!!!' },
    );
    expect([c1.url_slug, c2.url_slug]).toEqual([
      `dup-chapter-${tag}`,
      `dup-chapter-${tag}-2`,
    ]);
    expect(c3.url_slug).toBe(`chapter-${digits}`);
    expect(c4.url_slug).toMatch(/^chapter(-\d+)?$/);
    const q1 = await create('super', '/content/quizzes', {
      title: `Dup quiz ${tag}`,
      duration_min: 10,
      pass_marks: 0,
      subject_id: Number(e.subject.id),
    });
    const q2 = await create('super', '/content/quizzes', {
      title: `Dup quiz ${tag}`,
      duration_min: 10,
      pass_marks: 0,
      subject_id: Number(e.subject.id),
    });
    expect([q1.slug, q2.slug]).toEqual([
      `dup-quiz-${tag}`,
      `dup-quiz-${tag}-2`,
    ]);
    quizIds.push(q1.id, q2.id);
    const l = async () => {
      const res = await http()
        .post(`/api/v1/content/chapters/${c1.url_slug}/lessons`)
        .set({ Authorization: `Bearer ${t.super}` })
        .field('title', `Dup lesson ${tag}`)
        .field('type', 'text')
        .field('content_body', 'x')
        .expect((r) => expect(r.status).toBeLessThan(300));
      return res.body.data as Record<string, any>;
    };
    const l1 = await l();
    const l2 = await l();
    expect([l1.url_slug, l2.url_slug]).toEqual([
      `dup-lesson-${tag}`,
      `dup-lesson-${tag}-2`,
    ]);

    // A renamed lesson keeps its slug.
    const [row] = await db.select().from(lessons).where(eq(lessons.id, l1.id));
    expect(row.url_slug).toBe(`dup-lesson-${tag}`);

    // The numeric id of a created row still works, so does its slug.
    await api('super', `/content/lessons/${l2.url_slug}`).expect(200);
    await api('super', `/content/lessons/${l2.id}`).expect(200);
  });
});
