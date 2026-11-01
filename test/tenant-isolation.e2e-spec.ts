process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  attendance,
  chapters,
  class_student,
  classes,
  lessons,
  questions,
  quiz_attempts,
  quizzes,
  schools,
  subjects,
  users,
} from '../src/db/schema';

loadEnv();
jest.setTimeout(60_000);

/**
 * Tenant isolation and content scoping fixes that deliberately differ from
 * legacy (`// security: not in legacy` in src/). Runs on the seeded local
 * database: a second school with its own users/class/subject/lesson/quiz is
 * created in beforeAll and removed in afterAll. Seed ids used: school 1; admin
 * 2, teacher 3 (class 1), student 4 (grade 10, syllabus 4), parent 5, super
 * admin 1, demo student 14 (grade 9), B2C student 8 (no active subscription);
 * subject 8 / chapter 17 (syllabus 4).
 */
describe('Tenant isolation (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const http = () => request(app.getHttpServer());
  const get = (who: string, path: string) =>
    http().get(`/api/v1${path}`).set(as(who));
  const post = (who: string, path: string, body: object = {}) =>
    http().post(`/api/v1${path}`).set(as(who)).send(body);

  const fx = {
    school: 0n,
    otherStudent: 0n,
    otherTeacher: 0n,
    otherClass: 0n,
    otherSubject: 0n,
    otherChapter: 0n,
    otherLesson: 0n,
    otherQuiz: 0n,
    hiddenLesson: 0n, // unpublished lesson in a published chapter (subject 8)
    hiddenChapter: 0n, // unpublished chapter (subject 8)
    hiddenChapterLesson: 0n,
  };
  const attemptIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);

    for (const [who, identifier] of [
      ['admin', 'admin@bodhira.test'],
      ['teacher', 'teacher@bodhira.test'],
      ['student', 'student@bodhira.test'],
      ['grade9', 'demo.stu2@bodhira.test'],
      ['expired', 'aarav1780466327@example.com'],
    ]) {
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ identifier, password: 'password', device: 'e2e' })
        .expect(200);
      tokens[who] = (res.body as { data: { token: string } }).data.token;
    }

    const now = new Date();
    const stamp = { created_at: now, updated_at: now };
    const tag = Date.now();
    const [school] = await db
      .insert(schools)
      .values({
        name: 'E2E Tenant School',
        slug: `e2e-tenant-${tag}`,
        code: `e2e${tag % 100000}`,
        ...stamp,
      })
      .returning();
    fx.school = school.id;
    const [stu] = await db
      .insert(users)
      .values({
        name: 'E2E Other Student',
        role: 'student',
        school_id: school.id,
        grade: '10',
        ...stamp,
      })
      .returning();
    fx.otherStudent = stu.id;
    const [tea] = await db
      .insert(users)
      .values({
        name: 'E2E Other Teacher',
        role: 'teacher',
        school_id: school.id,
        ...stamp,
      })
      .returning();
    fx.otherTeacher = tea.id;
    const [cls] = await db
      .insert(classes)
      .values({
        school_id: school.id,
        grade: '10',
        section: 'Z',
        class_teacher_id: tea.id,
        ...stamp,
      })
      .returning();
    fx.otherClass = cls.id;
    const [sub] = await db
      .insert(subjects)
      .values({
        school_id: school.id,
        name: 'E2E Secret',
        slug: `e2e-secret-${tag}`,
        ...stamp,
      })
      .returning();
    fx.otherSubject = sub.id;
    const [chap] = await db
      .insert(chapters)
      .values({
        subject_id: sub.id,
        title: 'Secret chapter',
        slug: `secret-${tag}`,
        ...stamp,
      })
      .returning();
    fx.otherChapter = chap.id;
    const [les] = await db
      .insert(lessons)
      .values({
        chapter_id: chap.id,
        title: 'Secret lesson',
        slug: `secret-lesson-${tag}`,
        ...stamp,
      })
      .returning();
    fx.otherLesson = les.id;
    const [quiz] = await db
      .insert(quizzes)
      .values({
        school_id: school.id,
        subject_id: sub.id,
        title: 'Secret quiz',
        is_published: true,
        ...stamp,
      })
      .returning();
    fx.otherQuiz = quiz.id;

    // Unpublished content inside an accessible subject (8, syllabus 4, grade 10).
    const [hl] = await db
      .insert(lessons)
      .values({
        chapter_id: 17n,
        title: 'Draft lesson',
        slug: `draft-lesson-${tag}`,
        is_published: false,
        ...stamp,
      })
      .returning();
    fx.hiddenLesson = hl.id;
    const [hc] = await db
      .insert(chapters)
      .values({
        subject_id: 8n,
        title: 'Draft chapter',
        slug: `draft-chapter-${tag}`,
        is_published: false,
        ...stamp,
      })
      .returning();
    fx.hiddenChapter = hc.id;
    const [hcl] = await db
      .insert(lessons)
      .values({
        chapter_id: hc.id,
        title: 'Lesson of a draft chapter',
        slug: `draft-ch-lesson-${tag}`,
        ...stamp,
      })
      .returning();
    fx.hiddenChapterLesson = hcl.id;
  });

  afterAll(async () => {
    if (attemptIds.length)
      await db
        .delete(quiz_attempts)
        .where(inArray(quiz_attempts.id, attemptIds));
    await db
      .delete(class_student)
      .where(
        and(
          eq(class_student.class_id, 1n),
          inArray(class_student.student_id, [5n, fx.otherStudent]),
        ),
      );
    // Safety net: attendance rows this file's requests might have written.
    await db
      .delete(attendance)
      .where(
        and(
          eq(attendance.class_id, 1n),
          eq(attendance.date, new Date('2026-01-05T00:00:00Z')),
        ),
      );
    await db
      .delete(lessons)
      .where(inArray(lessons.id, [fx.hiddenLesson, fx.hiddenChapterLesson]));
    await db.delete(chapters).where(eq(chapters.id, fx.hiddenChapter));
    // Cascades: the fixture school's subjects, chapters, lessons, classes, quizzes.
    await db.delete(schools).where(eq(schools.id, fx.school));
    await db
      .delete(users)
      .where(inArray(users.id, [fx.otherStudent, fx.otherTeacher]));
    for (const who of Object.keys(tokens))
      await http().post('/api/v1/auth/logout').set(as(who));
    await app.close();
  });

  // ── 1, 2. enrolment, class teacher, subject links ──

  describe('enrolment', () => {
    it.each([
      ['a super admin', () => 1n],
      ['a parent of the same school', () => 5n],
      ['a student of another school', () => fx.otherStudent],
    ])('refuses to enrol %s (422 student_id)', async (_n, id) => {
      const res = await post('admin', '/admin/classes/1/students', {
        student_id: Number(id()),
      }).expect(422);
      expect(res.body.errors.student_id).toEqual([
        'The selected student must be a student of your school.',
      ]);
    });

    it('still 403s for a class of another school', async () => {
      await post('admin', `/admin/classes/${fx.otherClass}/students`, {
        student_id: 4,
      }).expect(403);
    });

    it('class_teacher_id must be a teacher of the admin school', async () => {
      for (const id of [fx.otherTeacher, 1n, 4n]) {
        const res = await post('admin', '/admin/classes', {
          grade: '8',
          section: 'Q',
          class_teacher_id: Number(id),
        }).expect(422);
        expect(res.body.errors).toHaveProperty('class_teacher_id');
      }
    });

    it('linkSubject checks subject and teacher ownership', async () => {
      const bad = async (body: object, field: string) => {
        const res = await post(
          'admin',
          '/admin/classes/1/subjects',
          body,
        ).expect(422);
        expect(res.body.errors).toHaveProperty(field);
      };
      await bad({ subject_id: Number(fx.otherSubject) }, 'subject_id');
      // platform subject of syllabus 5, which school 1 has not opted into
      await bad({ subject_id: 7 }, 'subject_id');
      await bad(
        { subject_id: 1, teacher_id: Number(fx.otherTeacher) },
        'teacher_id',
      );
      await bad({ subject_id: 1, teacher_id: 4 }, 'teacher_id');
    });
  });

  describe('roster', () => {
    beforeAll(async () => {
      const now = new Date();
      // Plant a parent and a student of another school in the teacher's class.
      await db.insert(class_student).values([
        { class_id: 1n, student_id: 5n, created_at: now, updated_at: now },
        {
          class_id: 1n,
          student_id: fx.otherStudent,
          created_at: now,
          updated_at: now,
        },
      ]);
    });

    it.each([
      ['a parent', () => 5n],
      ['a student of another school', () => fx.otherStudent],
    ])(
      'cannot edit, block or delete %s enrolled in the class',
      async (_n, id) => {
        const base = `/api/v1/teacher/classes/1/students/${id()}`;
        const h = as('teacher');
        await http()
          .put(base)
          .set(h)
          .send({
            name: 'Hijacked',
            email: 'hijack@example.com',
            password: 'abcdef1',
          })
          .expect(404);
        await http()
          .patch(`${base}/status`)
          .set(h)
          .send({ status: 'blocked' })
          .expect(404);
        await http().delete(base).set(h).expect(404);
        const [row] = await db.select().from(users).where(eq(users.id, id()));
        expect(row.name).not.toBe('Hijacked');
        expect(row.status).not.toBe('blocked');
      },
    );

    it('the student profile of a non-student is forbidden', async () => {
      await get('teacher', '/teacher/students/5').expect(403);
      await get('teacher', `/teacher/students/${fx.otherStudent}`).expect(403);
    });

    it('a real student of the class still reaches validation', async () => {
      await http()
        .put('/api/v1/teacher/classes/1/students/4')
        .set(as('teacher'))
        .send({})
        .expect(422);
    });
  });

  // ── 3. attendance ──

  it('attendance rejects ids that are not enrolled students of the class (422 records)', async () => {
    for (const records of [
      { '5': 'present' }, // a parent planted in the class by the roster tests
      { '4': 'present', '999999': 'absent' },
      { abc: 'present' },
    ]) {
      const res = await post('teacher', '/teacher/classes/1/attendance', {
        date: '2026-01-05',
        records,
      }).expect(422);
      expect(res.body.errors).toHaveProperty('records');
    }
  });

  // ── 4. live classes ──

  describe('live classes', () => {
    const future = new Date(Date.now() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');
    const base = {
      title: 'E2E live',
      scheduled_at: future,
      duration_min: 30,
      provider: 'external',
      meeting_url: 'https://meet.example.com/room',
    };

    it('refuses a class the teacher does not teach (403)', async () => {
      await post('teacher', '/teacher/live-classes', {
        ...base,
        scope_type: 'class',
        class_id: Number(fx.otherClass),
      }).expect(403);
    });

    it('refuses a syllabus the school does not use (422 syllabus_id)', async () => {
      // Syllabus 4 counts as used: a school 1 student (id 4) is on it.
      for (const id of [5]) {
        const res = await post('teacher', '/teacher/live-classes', {
          ...base,
          scope_type: 'syllabus',
          syllabus_id: id,
        }).expect(422);
        expect(res.body.errors).toHaveProperty('syllabus_id');
      }
    });

    it('refuses a subject of another school (422 subject_id)', async () => {
      const res = await post('teacher', '/teacher/live-classes', {
        ...base,
        scope_type: 'class',
        class_id: 1,
        subject_id: Number(fx.otherSubject),
      }).expect(422);
      expect(res.body.errors).toHaveProperty('subject_id');
    });

    it('requires an https meeting url (422 meeting_url)', async () => {
      for (const meeting_url of [
        'http://meet.example.com/room',
        'ftp://meet.example.com/room',
      ]) {
        const res = await post('teacher', '/teacher/live-classes', {
          ...base,
          scope_type: 'class',
          class_id: 1,
          meeting_url,
        }).expect(422);
        expect(res.body.errors).toHaveProperty('meeting_url');
      }
    });

    it('the schedule form only offers syllabi the school uses', async () => {
      const { body } = await get(
        'teacher',
        '/teacher/live-classes/scopes',
      ).expect(200);
      const ids = (body.data.syllabi as { id: number }[]).map((s) => s.id);
      // 1 and 2: opted in or taught; 4: a student of the school is on it.
      expect(ids.sort()).toEqual([1, 2, 4]);
    });
  });

  // ── 5. content scoping ──

  describe('student content scoping', () => {
    const msg = 'Subject not available for your school.';

    it('another school’s lesson, chapter, progress, quiz and start are 403', async () => {
      for (const res of [
        await get('student', `/student/lessons/${fx.otherLesson}`),
        await get('student', `/student/chapters/${fx.otherChapter}/lessons`),
        await post('student', `/student/lessons/${fx.otherLesson}/progress`, {
          watched_seconds: 5,
        }),
        await get('student', `/student/quizzes/${fx.otherQuiz}`),
        await post('student', `/student/quizzes/${fx.otherQuiz}/start`),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.message).toBe(msg);
      }
    });

    it('a platform syllabus the student is not on is 403', async () => {
      // chapter 16 belongs to subject 7 (syllabus 5); the student is on syllabus 4
      await get('student', '/student/chapters/16/lessons').expect(403);
    });

    it('unpublished content is not found', async () => {
      await get('student', `/student/lessons/${fx.hiddenLesson}`).expect(404);
      await get('student', `/student/lessons/${fx.hiddenChapterLesson}`).expect(
        404,
      );
      await get(
        'student',
        `/student/chapters/${fx.hiddenChapter}/lessons`,
      ).expect(404);
      await post('student', `/student/lessons/${fx.hiddenLesson}/progress`, {
        watched_seconds: 5,
      }).expect(404);
      await get('student', '/student/quizzes/16').expect(404); // seeded draft quiz
    });

    it('the student’s own published content still opens', async () => {
      await get('student', '/student/lessons/68').expect(200);
      await get('student', '/student/chapters/17/lessons').expect(200);
    });
  });

  // ── 6. paywall ──

  describe('subscription gate', () => {
    it('answers 402 subscription_inactive on gated learning routes', async () => {
      for (const path of [
        '/student/subjects',
        '/student/subjects/8',
        '/student/chapters/17/lessons',
        '/student/lessons/68',
        '/student/quizzes',
        '/student/quizzes/2',
        '/student/assignments',
        '/student/live-classes',
        // Gap fixes 2026-11-01 (legacy web gated these too).
        '/student/profile',
        '/student/profile/report',
        '/student/badges',
        '/student/ai/sessions',
        '/student/ai/sessions/1',
        '/student/ai/recommendations',
        '/student/ai/tokens',
      ]) {
        const res = await get('expired', path);
        expect([path, res.status]).toEqual([path, 402]);
        expect(res.body).toEqual({
          success: false,
          message:
            'Your subscription is not active. Please complete checkout to continue.',
          code: 'subscription_inactive',
        });
      }
      await post('expired', '/student/quizzes/2/start').expect(402);
      await post('expired', '/student/attempts/1/answer', {}).expect(402);
      await post('expired', '/student/lessons/68/progress', {
        watched_seconds: 1,
      }).expect(402);
      await post('expired', '/student/ai/sessions', { body: 'hi' }).expect(402);
      await post('expired', '/student/ai/sessions/1/messages', {
        body: 'hi',
      }).expect(402);
    });

    it('keeps access reachable, and gates home like legacy web', async () => {
      const access = await get('expired', '/student/access').expect(200);
      expect(access.body.data).toEqual({ has_access: false });
      const home = await get('expired', '/student/home').expect(402);
      expect(home.body.code).toBe('subscription_inactive');
    });

    it('does not gate a subscribed student', async () => {
      await get('student', '/student/subjects').expect(200);
    });
  });

  // ── 7. quiz integrity ──

  describe('quiz attempt', () => {
    it('hides the answer key until the attempt is submitted', async () => {
      const [q] = await db
        .select()
        .from(questions)
        .where(eq(questions.quiz_id, 2n))
        .orderBy(questions.id)
        .limit(1);
      const start = await post('grade9', '/student/quizzes/2/start').expect(
        200,
      );
      const attempt = start.body.data.attempt.id as number;
      attemptIds.push(BigInt(attempt));

      const ans = await post('grade9', `/student/attempts/${attempt}/answer`, {
        question_id: Number(q.id),
        answer: ['A'],
      }).expect(200);
      expect(ans.body.data).toEqual({ question_id: Number(q.id) });
      // changing the answer before submit stays allowed (the apps autosave)
      await post('grade9', `/student/attempts/${attempt}/answer`, {
        question_id: Number(q.id),
        answer: ['B'],
      }).expect(200);

      const open = (
        await get('grade9', `/student/attempts/${attempt}`).expect(200)
      ).body.data;
      expect(open.status).toBe('in_progress');
      expect(open.answers).toHaveLength(1);
      expect(open.answers[0].answer).toEqual(['B']);
      for (const k of [
        'correct_answer',
        'explanation',
        'is_correct',
        'marks_awarded',
      ])
        expect(open.answers[0][k]).toBeNull();

      await post('grade9', `/student/attempts/${attempt}/submit`).expect(200);
      const done = (
        await get('grade9', `/student/attempts/${attempt}`).expect(200)
      ).body.data;
      expect(done.status).toBe('submitted');
      expect(typeof done.answers[0].is_correct).toBe('boolean');
      expect(Array.isArray(done.answers[0].correct_answer)).toBe(true);
    });
  });
});
