import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { asc, myDesc } from '../db/helpers';
import {
  achievements,
  ai_chat_messages,
  ai_chat_sessions,
  attendance,
  quiz_attempts,
  quizzes,
  schools,
  subjects,
  syllabi,
} from '../db/schema';
import type { users } from '../db/types';
import { AiService } from '../ai/ai.service';
import { iso8601 } from '../common/http/laravel';
import { StudentService, levelInfo } from './student.service';
import {
  attendanceSummary,
  classifyAiSessions,
  reportContentDisposition,
} from './student-report';
import { renderStudentReportPdf, type ReportData } from './student-report-pdf';

/**
 * Port of StudentController::profileReport() and ::profileExtras() (the
 * "Download Report" PDF). Content and business rules follow
 * resources/views/student/report.blade.php.
 *
 * Legacy quirks kept:
 *  - the first attendance cell is the percent but is labelled "Present", like
 *    the second one (the view does that);
 *  - a passed attempt needs a quiz row with score >= pass_marks, so a deleted
 *    quiz reads "Failed" (cannot happen with the FK; kept for the rule).
 * Not computed (profileExtras returns them but the report never shows them):
 * attendance `recent`/`records`, the AI token allowance (`remaining`, `limit`,
 * `used_percent`) and the subject/other split, which only feeds the profile
 * page; `classifyAiSessions` in student-report.ts is the tested port of the split.
 */
@Injectable()
export class StudentReportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly students: StudentService,
    private readonly ai: AiService,
  ) {}

  async build(user: users, now = new Date()): Promise<ReportData> {
    const summary = await this.students.profileSummary(user);

    const attemptRows = await this.db
      .select({
        title: quizzes.title,
        subject: subjects.name,
        score: quiz_attempts.score,
        total_marks: quiz_attempts.total_marks,
        pass_marks: quizzes.pass_marks,
        submitted_at: quiz_attempts.submitted_at,
      })
      .from(quiz_attempts)
      .leftJoin(quizzes, eq(quizzes.id, quiz_attempts.quiz_id))
      .leftJoin(subjects, eq(subjects.id, quizzes.subject_id))
      .where(
        and(
          eq(quiz_attempts.student_id, user.id),
          eq(quiz_attempts.status, 'submitted'),
        ),
      )
      .orderBy(myDesc(quiz_attempts.submitted_at), asc(quiz_attempts.id));

    const statuses = (
      await this.db
        .select({ status: attendance.status })
        .from(attendance)
        .where(eq(attendance.student_id, user.id))
    ).map((r) => r.status);

    const sessions = await this.db
      .select({ id: ai_chat_sessions.id })
      .from(ai_chat_sessions)
      .where(eq(ai_chat_sessions.user_id, user.id));
    const ids = sessions.map((s) => s.id);
    let messages = 0;
    let tokens = 0;
    if (ids.length) {
      const [m] = await this.db
        .select({
          n: sql<number>`count(*)`.mapWith(Number),
          t: sql<number>`coalesce(sum(${ai_chat_messages.tokens}), 0)`.mapWith(
            Number,
          ),
        })
        .from(ai_chat_messages)
        .where(inArray(ai_chat_messages.session_id, ids));
      messages = m.n;
      tokens = m.t;
    }

    const [school] = user.school_id
      ? await this.db
          .select()
          .from(schools)
          .where(eq(schools.id, user.school_id))
      : [];
    const [syllabus] = user.syllabus_id
      ? await this.db
          .select()
          .from(syllabi)
          .where(eq(syllabi.id, user.syllabus_id))
      : [];

    return {
      student: {
        name: user.name,
        email: user.email,
        phone: user.phone,
        grade: user.grade,
        created_at: user.created_at,
      },
      board: syllabus ? syllabus.board : null,
      school: school?.name ?? null,
      xp: summary.xp,
      streak_days: summary.streak_days,
      lessons_completed: summary.lessons_completed,
      quizzes_attempted: summary.quizzes_attempted,
      avg_score_percent: summary.avg_score_percent,
      badges_count: await this.db.$count(
        achievements,
        eq(achievements.student_id, user.id),
      ),
      attempts: attemptRows,
      attendance: attendanceSummary(statuses),
      aiUsage: { sessions: ids.length, messages, tokens },
      generated_at: now,
    };
  }

  /**
   * Port of StudentController::profileExtras for the profile page and API
   * (not in the legacy API; legacy rendered it in the Blade view): quiz reports,
   * attendance with its calendar records, AI usage with the daily allowance.
   */
  async profileExtras(user: users, xp: number) {
    const attempts = await this.db
      .select({
        id: quiz_attempts.id,
        quiz_id: quiz_attempts.quiz_id,
        title: quizzes.title,
        subject: subjects.name,
        score: quiz_attempts.score,
        total_marks: quiz_attempts.total_marks,
        pass_marks: quizzes.pass_marks,
        submitted_at: quiz_attempts.submitted_at,
      })
      .from(quiz_attempts)
      .leftJoin(quizzes, eq(quizzes.id, quiz_attempts.quiz_id))
      .leftJoin(subjects, eq(subjects.id, quizzes.subject_id))
      .where(
        and(
          eq(quiz_attempts.student_id, user.id),
          eq(quiz_attempts.status, 'submitted'),
        ),
      )
      .orderBy(myDesc(quiz_attempts.submitted_at), asc(quiz_attempts.id));

    const att = await this.db
      .select({ date: attendance.date, status: attendance.status })
      .from(attendance)
      .where(eq(attendance.student_id, user.id))
      .orderBy(asc(attendance.date), asc(attendance.id));
    const summary = attendanceSummary(att.map((r) => r.status));

    const sessions = await this.db
      .select({ id: ai_chat_sessions.id, title: ai_chat_sessions.title })
      .from(ai_chat_sessions)
      .where(eq(ai_chat_sessions.user_id, user.id));
    const ids = sessions.map((s) => s.id);
    let messages = 0;
    let tokens = 0;
    if (ids.length) {
      const [m] = await this.db
        .select({
          n: sql<number>`count(*)`.mapWith(Number),
          t: sql<number>`coalesce(sum(${ai_chat_messages.tokens}), 0)`.mapWith(
            Number,
          ),
        })
        .from(ai_chat_messages)
        .where(inArray(ai_chat_messages.session_id, ids));
      messages = m.n;
      tokens = m.t;
    }
    const subjectNames = (await this.students.subjectsForStudent(user)).map(
      (s) => s.name,
    );
    const tok = await this.ai.tokenStatus(user);

    const [school] = user.school_id
      ? await this.db
          .select()
          .from(schools)
          .where(eq(schools.id, user.school_id))
      : [];
    const [syllabus] = user.syllabus_id
      ? await this.db
          .select()
          .from(syllabi)
          .where(eq(syllabi.id, user.syllabus_id))
      : [];

    return {
      attempts: attempts.map((a) => ({
        id: a.id,
        quiz_id: a.quiz_id,
        title: a.title,
        subject: a.subject,
        score: a.score,
        total_marks: a.total_marks,
        percent:
          a.total_marks > 0 ? Math.round((a.score / a.total_marks) * 100) : 0,
        passed: a.pass_marks !== null && a.score >= a.pass_marks,
        pass_marks: a.pass_marks,
        submitted_at: iso8601(a.submitted_at),
      })),
      attendance: {
        ...summary,
        recent: [...att]
          .reverse()
          .slice(0, 10)
          .map((r) => ({
            date: r.date.toISOString().slice(0, 10),
            status: r.status,
          })),
        records: Object.fromEntries(
          att.map((r) => [r.date.toISOString().slice(0, 10), r.status]),
        ),
      },
      ai_usage: {
        sessions: ids.length,
        messages,
        tokens,
        remaining: tok.remaining,
        limit: tok.limit,
        used_percent: tok.percent,
        ...classifyAiSessions(
          sessions.map((x) => x.title),
          subjectNames,
        ),
      },
      badges_count: await this.db.$count(
        achievements,
        eq(achievements.student_id, user.id),
      ),
      board: syllabus ? syllabus.board : null,
      syllabus: syllabus ? syllabus.name : null,
      is_individual: !user.school_id,
      school_name: school?.name ?? null,
      ...levelInfo(xp),
    };
  }

  async render(user: users) {
    const pdf = await renderStudentReportPdf(await this.build(user));
    return { pdf, ...reportContentDisposition(user) };
  }
}
