process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  attendance,
  class_student,
  classes,
  lesson_progress,
  personal_access_tokens,
  quiz_attempts,
  quizzes,
  schools,
  users,
} from '../src/db/schema';
import type { users as User } from '../src/db/types';

loadEnv();

const tag = randomBytes(3).toString('hex');
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** Today's UTC date minus `n` days, as YYYY-MM-DD. */
const dayAgo = (n: number) => {
  const d = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const label = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;

/**
 * GET /admin/analytics (rewritten as grouped queries) checked against
 * independent SQL over a school built for the test, plus GET /super/ai-usage.
 * Every row the test makes is removed afterwards.
 *
 * Fixture: classes A (s1, s2), B (s3, s1) and C (empty); s4 is in the school
 * but no class; `outsider` is in another school with attendance in the same
 * week. Attendance and quiz attempts are spread over today, the last week
 * and earlier.
 */
describe('Admin analytics and super AI usage (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  const createdUsers: bigint[] = [];
  const createdSchools: bigint[] = [];
  const u: Record<string, User> = {};
  const t: Record<string, string> = {};
  const cls: Record<string, bigint> = {};
  let schoolId: bigint;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

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
          code: `AN${name.slice(0, 2).toUpperCase()}${tag.toUpperCase()}`,
          created_at: now,
          updated_at: now,
        })
        .returning();
      createdSchools.push(s.id);
      return s.id;
    };
    schoolId = await mkSchool('Analytics');
    const otherSchool = await mkSchool('Elsewhere');

    for (const [who, role, school] of [
      ['admin', 'admin', schoolId],
      ['teacher', 'teacher', schoolId],
      ['otherAdmin', 'admin', otherSchool],
      ['s1', 'student', schoolId],
      ['s2', 'student', schoolId],
      ['s3', 'student', schoolId],
      ['s4', 'student', schoolId],
      ['outsider', 'student', otherSchool],
    ] as const) {
      const [user] = await db
        .insert(users)
        .values({
          name: `An ${who} ${tag}`,
          email: `analytics-${tag}-${who}@bodhira.test`,
          password: 'x',
          role,
          status: 'active',
          school_id: school,
          created_at: now,
          updated_at: now,
        })
        .returning();
      createdUsers.push(user.id);
      u[who] = user;
      t[who] = await tokens.issue(user, 'e2e', [`role:${role}`]);
    }
    const superUser = (await db.query.users.findFirst({
      where: eq(users.email, 'super@bodhira.test'),
    }))!;
    t.super = await tokens.issue(superUser, 'e2e', ['role:super_admin']);

    for (const [key, section, school] of [
      ['A', `A${tag}`, schoolId],
      ['B', `B${tag}`, schoolId],
      ['C', `C${tag}`, schoolId],
      ['X', `X${tag}`, otherSchool],
    ] as const) {
      const [c] = await db
        .insert(classes)
        .values({
          school_id: school,
          grade: '7',
          section,
          created_at: now,
          updated_at: now,
        })
        .returning();
      cls[key] = c.id;
    }
    await db.insert(class_student).values([
      { class_id: cls.A, student_id: u.s1.id },
      { class_id: cls.A, student_id: u.s2.id },
      { class_id: cls.B, student_id: u.s3.id },
      { class_id: cls.B, student_id: u.s1.id },
      { class_id: cls.X, student_id: u.outsider.id },
    ]);

    const mark = (c: string, s: string, days: number, status: string) => ({
      class_id: cls[c],
      student_id: u[s].id,
      date: dayAgo(days),
      status,
      created_at: now,
      updated_at: now,
    });
    await db.insert(attendance).values([
      mark('A', 's1', 0, 'present'),
      mark('A', 's2', 0, 'late'),
      mark('A', 's1', 1, 'absent'),
      mark('A', 's2', 3, 'present'),
      mark('A', 's1', 10, 'present'), // outside the 7-day window
      mark('B', 's3', 1, 'present'),
      mark('B', 's3', 6, 'excused'),
      mark('B', 's1', 7, 'absent'), // 7 days ago: just outside the window
      mark('X', 'outsider', 0, 'absent'), // another school
    ]);

    const [quiz] = await db
      .insert(quizzes)
      .values({
        school_id: schoolId,
        created_by: u.teacher.id,
        title: `Analytics quiz ${tag}`,
        total_marks: 10,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const attempt = (
      s: string,
      score: number,
      total: number,
      status = 'submitted',
    ) => ({
      quiz_id: quiz.id,
      student_id: u[s].id,
      status,
      score,
      total_marks: total,
      submitted_at: status === 'submitted' ? now : null,
    });
    await db.insert(quiz_attempts).values([
      attempt('s1', 8, 10),
      attempt('s1', 5, 10),
      attempt('s2', 0, 0), // total 0 counts as 0 %
      attempt('s3', 7, 7),
      attempt('s3', 2, 7, 'in_progress'),
      attempt('s4', 6, 6),
      attempt('outsider', 1, 10),
    ]);

    const lesson = await db.query.lessons.findFirst({
      orderBy: (l, { asc }) => [asc(l.id)],
    });
    if (lesson) {
      await db.insert(lesson_progress).values([
        {
          student_id: u.s1.id,
          lesson_id: lesson.id,
          status: 'completed',
          watched_seconds: 60,
          progress_percent: 100,
          completed_at: now,
          last_viewed_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          student_id: u.s2.id,
          lesson_id: lesson.id,
          status: 'in_progress',
          watched_seconds: 10,
          progress_percent: 20,
          last_viewed_at: now,
          created_at: now,
          updated_at: now,
        },
      ]);
    }
  });

  afterAll(async () => {
    if (db) {
      if (createdUsers.length) {
        await db
          .delete(personal_access_tokens)
          .where(inArray(personal_access_tokens.tokenable_id, createdUsers));
      }
      if (t.super) {
        await http().post('/api/v1/auth/logout').set(as('super'));
      }
      if (createdSchools.length) {
        // attendance, class_student cascade from classes; attempts from quizzes.
        await db
          .delete(quizzes)
          .where(inArray(quizzes.school_id, createdSchools));
        await db
          .delete(classes)
          .where(inArray(classes.school_id, createdSchools));
      }
      // lesson_progress and anything left cascade from the users.
      if (createdUsers.length)
        await db.delete(users).where(inArray(users.id, createdUsers));
      if (createdSchools.length)
        await db.delete(schools).where(inArray(schools.id, createdSchools));
    }
    await app?.close();
  });

  it('answers with the analytics shape', async () => {
    const { body } = await http()
      .get('/api/v1/admin/analytics')
      .set(as('admin'))
      .expect(200);
    expect(Object.keys(body.data)).toEqual([
      'classes',
      'attendance_trend',
      'totals',
    ]);
    expect(Object.keys(body.data.classes[0])).toEqual([
      'id',
      'label',
      'students',
      'attendance_percent',
      'avg_quiz_percent',
    ]);
    expect(Object.keys(body.data.totals)).toEqual([
      'lessons_completed',
      'quiz_attempts',
      'avg_quiz_percent',
    ]);
    expect(body.data.attendance_trend).toHaveLength(7);
    expect(Object.keys(body.data.attendance_trend[0])).toEqual([
      'date',
      'percent',
    ]);
  });

  it('matches independent SQL for per-class attendance and quiz averages', async () => {
    const { body } = await http()
      .get('/api/v1/admin/analytics')
      .set(as('admin'))
      .expect(200);
    const ref = (
      await db.execute<{
        id: string;
        students: number;
        att: number;
        quiz: number;
      }>(sql`
        select c.id::text as id,
          (select count(*)::int from class_student cs where cs.class_id = c.id) as students,
          coalesce((select round(100.0 * count(*) filter (where a.status = 'present') / nullif(count(*), 0))::int
                    from attendance a where a.class_id = c.id), 0) as att,
          coalesce((select round(avg(case when qa.total_marks > 0 then qa.score * 100.0 / qa.total_marks else 0 end))::int
                    from quiz_attempts qa join class_student cs on cs.student_id = qa.student_id
                    where cs.class_id = c.id and qa.status = 'submitted'), 0) as quiz
        from classes c where c.school_id = ${schoolId} order by c.id`)
    ).rows;
    expect(
      body.data.classes.map(
        (c: {
          id: number;
          students: number;
          attendance_percent: number;
          avg_quiz_percent: number;
        }) => ({
          id: String(c.id),
          students: c.students,
          att: c.attendance_percent,
          quiz: c.avg_quiz_percent,
        }),
      ),
    ).toEqual(ref);
    // The same numbers by hand:
    // A: 3 present of 5 rows = 60 %; quizzes of s1, s2: (80 + 50 + 0) / 3 = 43.
    // B: 1 present of 3 rows = 33 %; quizzes of s3, s1: (100 + 80 + 50) / 3 = 77.
    // C: no rows → 0 / 0.
    expect(ref).toEqual([
      { id: String(cls.A), students: 2, att: 60, quiz: 43 },
      { id: String(cls.B), students: 2, att: 33, quiz: 77 },
      { id: String(cls.C), students: 0, att: 0, quiz: 0 },
    ]);
    expect(body.data.classes.map((c: { label: string }) => c.label)).toEqual([
      `Grade 7 - A${tag}`,
      `Grade 7 - B${tag}`,
      `Grade 7 - C${tag}`,
    ]);
  });

  it('matches independent SQL for the 7-day trend and totals', async () => {
    const { body } = await http()
      .get('/api/v1/admin/analytics')
      .set(as('admin'))
      .expect(200);
    const trendRows = (
      await db.execute<{ d: string; pct: number }>(sql`
        select g.d::date::text as d,
          coalesce((select round(100.0 * count(*) filter (where a.status = 'present') / nullif(count(*), 0))::int
                    from attendance a join users s on s.id = a.student_id
                    where a.date = g.d::date and s.school_id = ${schoolId} and s.role = 'student'), 0) as pct
        from generate_series(${ymd(dayAgo(6))}::date, ${ymd(dayAgo(0))}::date, interval '1 day') as g(d)
        order by g.d`)
    ).rows;
    expect(body.data.attendance_trend).toEqual(
      trendRows.map((r) => ({
        date: label(new Date(`${r.d}T00:00:00Z`)),
        percent: r.pct,
      })),
    );
    // By hand: today s1 present + s2 late = 50; yesterday s1 absent + s3
    // present = 50; 3 days ago 100; 6 days ago excused = 0; the outsider's
    // absence today is not counted.
    expect(
      body.data.attendance_trend.map((d: { percent: number }) => d.percent),
    ).toEqual([0, 0, 0, 100, 0, 50, 50]);

    const [tot] = (
      await db.execute<{ lessons: number; attempts: number }>(sql`
        select
          (select count(*)::int from lesson_progress lp join users s on s.id = lp.student_id
            where s.school_id = ${schoolId} and s.role = 'student' and lp.status = 'completed') as lessons,
          (select count(*)::int from quiz_attempts qa join users s on s.id = qa.student_id
            where s.school_id = ${schoolId} and s.role = 'student' and qa.status = 'submitted') as attempts`)
    ).rows;
    const classAvg =
      body.data.classes.reduce(
        (n: number, c: { avg_quiz_percent: number }) => n + c.avg_quiz_percent,
        0,
      ) / body.data.classes.length;
    expect(body.data.totals).toEqual({
      lessons_completed: tot.lessons,
      quiz_attempts: tot.attempts,
      avg_quiz_percent: Math.round(classAvg),
    });
    // s4's attempt counts in the school total but in no class.
    expect(tot.attempts).toBe(5);
    expect(body.data.totals.avg_quiz_percent).toBe(40);
  });

  it('keeps analytics to the admin’s school and role', async () => {
    const other = await http()
      .get('/api/v1/admin/analytics')
      .set(as('otherAdmin'))
      .expect(200);
    expect(
      other.body.data.classes.map((c: { id: number }) => BigInt(c.id)),
    ).toEqual([cls.X]);
    expect(other.body.data.classes[0]).toEqual(
      expect.objectContaining({
        students: 1,
        attendance_percent: 0,
        avg_quiz_percent: 10,
      }),
    );
    await http().get('/api/v1/admin/analytics').set(as('teacher')).expect(403);
    await http().get('/api/v1/admin/analytics').set(as('s1')).expect(403);
    await http().get('/api/v1/admin/analytics').expect(401);
  });

  it('serves super AI usage with totals from SQL, to super admins only', async () => {
    const { body } = await http()
      .get('/api/v1/super/ai-usage')
      .set(as('super'))
      .expect(200);
    expect(Object.keys(body.data)).toEqual([
      'totals',
      'top_users',
      'engagement_14d',
    ]);
    expect(Object.keys(body.data.totals)).toEqual([
      'sessions',
      'messages',
      'tokens',
      'avg_messages_per_session',
    ]);
    const [ref] = (
      await db.execute<{ sessions: number; messages: number; tokens: number }>(
        sql`select (select count(*)::int from ai_chat_sessions) as sessions,
                   (select count(*)::int from ai_chat_messages) as messages,
                   (select coalesce(sum(tokens), 0)::int from ai_chat_messages) as tokens`,
      )
    ).rows;
    expect(body.data.totals).toEqual({
      sessions: ref.sessions,
      messages: ref.messages,
      tokens: ref.tokens,
      avg_messages_per_session:
        ref.sessions > 0
          ? Math.round((ref.messages / ref.sessions) * 10) / 10
          : 0,
    });
    expect(body.data.top_users.length).toBeLessThanOrEqual(5);
    for (const row of body.data.top_users)
      expect(Object.keys(row)).toEqual(['name', 'role', 'sessions']);
    const days = body.data.engagement_14d;
    expect(days).toHaveLength(14);
    expect(days.map((d: { date: string }) => d.date)).toEqual(
      Array.from({ length: 14 }, (_, k) => label(dayAgo(13 - k))),
    );
    expect(Object.keys(days[0])).toEqual([
      'date',
      'sessions',
      'lessons',
      'attempts',
    ]);
    // Today's submitted attempts include the fixture's six.
    const [today] = (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from quiz_attempts
            where submitted_at >= ${ymd(dayAgo(0))}::date and submitted_at < ${ymd(dayAgo(-1))}::date`,
      )
    ).rows;
    expect(days[13].attempts).toBe(today.n);
    expect(days[13].attempts).toBeGreaterThanOrEqual(6);

    await http().get('/api/v1/super/ai-usage').set(as('admin')).expect(403);
    await http().get('/api/v1/super/ai-usage').set(as('s1')).expect(403);
    await http().get('/api/v1/super/ai-usage').expect(401);
  });
});
