import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { toModel } from '../common/http/eloquent';
import { diffForHumans, modelNotFound } from '../common/http/laravel';
import { ApiException } from '../common/http/api.exception';
import { DB, type Db } from '../db/db';
import { asc, myDesc } from '../db/helpers';
import {
  assignment_submissions,
  assignments as assignmentsTable,
  attendance as attendanceTable,
  class_student,
  lesson_progress,
  parent_student,
  quiz_attempts,
  schools,
  users as usersTable,
} from '../db/schema';
import type { users } from '../db/types';
import { classLabel } from '../teacher/teacher.service';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const percent = (n: number, total: number) =>
  total > 0 ? Math.round((n / total) * 100) : 0;
const attemptPct = (a: { score: number; total_marks: number }) =>
  a.total_marks > 0 ? (a.score / a.total_marks) * 100 : 0;
const avgPct = (list: { score: number; total_marks: number }[]) =>
  list.length
    ? Math.round(list.reduce((n, a) => n + attemptPct(a), 0) / list.length)
    : 0;

/** PHP strtoupper is ASCII-only since 8.2. */
const asciiUpper = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/** Collection::groupBy — keys in first-seen order. */
function groupBy<T>(rows: T[], key: (r: T) => string) {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  return map;
}

/** Port of App\Services\ParentService. */
@Injectable()
export class ParentService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** `$parent->children()` with pivot `relation`, in relation order. */
  private children(parent: users) {
    return this.db.query.parent_student.findMany({
      where: eq(parent_student.parent_id, parent.id),
      orderBy: [asc(parent_student.student_id), asc(parent_student.id)],
      with: { users_parent_student_student_idTousers: true },
    });
  }

  async findStudent(id: bigint) {
    const u = await this.db.query.users.findFirst({
      where: eq(usersTable.id, id),
    });
    if (!u) throw modelNotFound('User', id);
    return u;
  }

  async guardChild(parent: users, student: users) {
    const link = await this.db.query.parent_student.findFirst({
      where: and(
        eq(parent_student.parent_id, parent.id),
        eq(parent_student.student_id, student.id),
      ),
      columns: { id: true },
      orderBy: [asc(parent_student.id)],
    });
    if (!link)
      throw new ApiException('You are not linked to this student.', 403);
  }

  async childrenList(parent: users) {
    return (await this.children(parent)).map((p) => ({
      id: p.users_parent_student_student_idTousers.id,
      name: p.users_parent_student_student_idTousers.name,
      grade: p.users_parent_student_student_idTousers.grade,
      relation: p.relation,
      // Not in legacy: the avatar, so apps can show the child's photo in lists.
      avatar: p.users_parent_student_student_idTousers.avatar,
    }));
  }

  async dashboard(parent: users) {
    const links = await this.children(parent);
    const alerts: {
      type: string;
      child: string;
      child_id: bigint;
      message: string;
    }[] = [];
    const cards = [];
    for (const link of links) {
      const child = link.users_parent_student_student_idTousers;
      const s = await this.childSummary(child);
      if (s.attendance_percent < 75 && s.attendance_total > 0) {
        alerts.push({
          type: 'attendance',
          child: child.name,
          // Not in legacy: lets apps link an alert to the right child.
          child_id: child.id,
          message: `Attendance dropped to ${s.attendance_percent}%`,
        });
      }
      if (s.avg_quiz_percent < 50 && s.quizzes_attempted > 0) {
        alerts.push({
          type: 'performance',
          child: child.name,
          // Not in legacy: lets apps link an alert to the right child.
          child_id: child.id,
          message: `Average quiz score is ${s.avg_quiz_percent}%`,
        });
      }
      if (s.pending_assignments > 0) {
        alerts.push({
          type: 'assignment',
          child: child.name,
          // Not in legacy: lets apps link an alert to the right child.
          child_id: child.id,
          message: `${s.pending_assignments} assignment(s) pending`,
        });
      }
      const school = child.school_id
        ? await this.db.query.schools.findFirst({
            where: eq(schools.id, child.school_id),
            columns: { name: true },
          })
        : null;
      cards.push({
        id: child.id,
        name: child.name,
        grade: child.grade,
        avatar_letter: asciiUpper([...child.name][0] ?? ''),
        relation: link.relation,
        school: school?.name ?? null,
        // Not in legacy: the avatar, so apps can show the child's photo.
        avatar: child.avatar,
        stats: s,
      });
    }
    return {
      parent: {
        id: parent.id,
        name: parent.name,
        children_count: links.length,
      },
      children: cards,
      alerts,
    };
  }

  private async enrolledClassIds(student: users) {
    const rows = await this.db.query.class_student.findMany({
      where: eq(class_student.student_id, student.id),
      columns: { class_id: true },
      orderBy: [asc(class_student.id)],
    });
    return rows.map((r) => r.class_id);
  }

  private async childSummary(student: users) {
    const attendance = await this.db.query.attendance.findMany({
      where: eq(attendanceTable.student_id, student.id),
      columns: { status: true },
      orderBy: [asc(attendanceTable.id)],
    });
    const present = attendance.filter((a) => a.status === 'present').length;
    const attempts = await this.db.query.quiz_attempts.findMany({
      where: and(
        eq(quiz_attempts.student_id, student.id),
        eq(quiz_attempts.status, 'submitted'),
      ),
      orderBy: [asc(quiz_attempts.id)],
    });
    const classIds = await this.enrolledClassIds(student);
    const assignmentIds = (
      await this.db.query.assignments.findMany({
        where: and(
          inArray(assignmentsTable.class_id, classIds),
          eq(assignmentsTable.is_published, true),
        ),
        columns: { id: true },
        orderBy: [asc(assignmentsTable.id)],
      })
    ).map((a) => a.id);
    const submitted = new Set(
      (
        await this.db.query.assignment_submissions.findMany({
          where: and(
            eq(assignment_submissions.student_id, student.id),
            inArray(assignment_submissions.assignment_id, assignmentIds),
          ),
          columns: { assignment_id: true },
          orderBy: [asc(assignment_submissions.id)],
        })
      ).map((s) => s.assignment_id),
    );

    return {
      attendance_total: attendance.length,
      attendance_present: present,
      attendance_percent: percent(present, attendance.length),
      quizzes_attempted: attempts.length,
      avg_quiz_percent: avgPct(attempts),
      pending_assignments: assignmentIds.filter((id) => !submitted.has(id))
        .length,
      lessons_started: await this.db.$count(
        lesson_progress,
        eq(lesson_progress.student_id, student.id),
      ),
      lessons_completed: await this.db.$count(
        lesson_progress,
        and(
          eq(lesson_progress.student_id, student.id),
          eq(lesson_progress.status, 'completed'),
        ),
      ),
    };
  }

  async childOverview(student: users) {
    const lessons = await this.db.query.lesson_progress.findMany({
      where: eq(lesson_progress.student_id, student.id),
      orderBy: [
        myDesc(lesson_progress.last_viewed_at),
        asc(lesson_progress.id),
      ],
      limit: 5,
      with: {
        lessons: { with: { chapters: { with: { subjects: true } } } },
      },
    });
    const quizzes = await this.db.query.quiz_attempts.findMany({
      where: and(
        eq(quiz_attempts.student_id, student.id),
        eq(quiz_attempts.status, 'submitted'),
      ),
      orderBy: [myDesc(quiz_attempts.submitted_at), asc(quiz_attempts.id)],
      limit: 5,
      with: { quizzes: { with: { subjects: true } } },
    });
    const school = student.school_id
      ? await this.db.query.schools.findFirst({
          where: eq(schools.id, student.school_id),
        })
      : null;

    return {
      student: toModel('users', student, {
        school: school ? toModel('schools', school) : null,
      }),
      stats: await this.childSummary(student),
      recent_lessons: lessons.map((p) => ({
        title: p.lessons?.title ?? null,
        subject: p.lessons?.chapters?.subjects?.name ?? null,
        status: p.status,
        progress: p.progress_percent,
        last_viewed_at: diffForHumans(p.last_viewed_at),
      })),
      recent_quizzes: quizzes.map((a) => ({
        title: a.quizzes?.title ?? null,
        subject: a.quizzes?.subjects?.name ?? null,
        score: a.score,
        total: a.total_marks,
        percent: percent(a.score, a.total_marks),
        submitted_at: diffForHumans(a.submitted_at),
      })),
    };
  }

  /** `?month=YYYY-MM` (Carbon::parse("$month-01")); defaults to the current month. */
  async childAttendance(student: users, month?: string | null) {
    const m =
      month && /^\d{4}-\d{2}$/.test(month)
        ? month
        : new Date().toISOString().slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const start = new Date(Date.UTC(y, mo - 1, 1));
    const end = new Date(Date.UTC(y, mo, 0));
    const rows = await this.db.query.attendance.findMany({
      where: and(
        eq(attendanceTable.student_id, student.id),
        gte(attendanceTable.date, start),
        lte(attendanceTable.date, end),
      ),
      orderBy: [asc(attendanceTable.date), asc(attendanceTable.id)],
    });
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const present = count('present');
    return {
      student: toModel('users', student),
      month: m,
      month_label: `${MONTHS[mo - 1]} ${y}`,
      totals: {
        present,
        absent: count('absent'),
        late: count('late'),
        excused: count('excused'),
        total: rows.length,
        percent: percent(present, rows.length),
      },
      records: rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        date_label: `${DAYS[r.date.getUTCDay()]}, ${MONTHS[r.date.getUTCMonth()].slice(0, 3)} ${r.date.getUTCDate()}`,
        status: r.status,
        remarks: r.remarks,
      })),
    };
  }

  async childPerformance(student: users) {
    const attempts = await this.db.query.quiz_attempts.findMany({
      where: and(
        eq(quiz_attempts.student_id, student.id),
        eq(quiz_attempts.status, 'submitted'),
      ),
      orderBy: [asc(quiz_attempts.id)],
      with: { quizzes: { with: { subjects: true } } },
    });
    const bySubject = [
      ...groupBy(attempts, (a) =>
        String(a.quizzes?.subjects?.id ?? 0),
      ).entries(),
    ]
      .map(([subjectId, group]) => {
        const subject = group[0].quizzes?.subjects;
        const avg = avgPct(group);
        return {
          subject_id: Number(subjectId),
          subject: subject?.name ?? 'Unknown',
          icon: subject?.icon ?? null,
          color: subject?.color ?? null,
          attempts: group.length,
          avg_percent: avg,
          highest: Math.max(...group.map((a) => a.score)),
          rating: avg >= 75 ? 'strong' : avg >= 50 ? 'fair' : 'weak',
        };
      })
      .sort((a, b) => a.avg_percent - b.avg_percent);

    const progress = await this.db.query.lesson_progress.findMany({
      where: eq(lesson_progress.student_id, student.id),
      orderBy: [asc(lesson_progress.id)],
      with: {
        lessons: { with: { chapters: { with: { subjects: true } } } },
      },
    });
    const progressBySubject = [
      ...groupBy(progress, (p) =>
        String(p.lessons?.chapters?.subjects?.id ?? 0),
      ).values(),
    ].map((group) => ({
      subject: group[0].lessons?.chapters?.subjects?.name ?? 'Unknown',
      started: group.length,
      completed: group.filter((p) => p.status === 'completed').length,
    }));

    return {
      student: toModel('users', student),
      by_subject: bySubject,
      progress: progressBySubject,
      overall_avg: avgPct(attempts),
    };
  }

  async childAssignments(student: users) {
    const classIds = await this.enrolledClassIds(student);
    const assignments = await this.db.query.assignments.findMany({
      where: and(
        inArray(assignmentsTable.class_id, classIds),
        eq(assignmentsTable.is_published, true),
      ),
      orderBy: [myDesc(assignmentsTable.due_date), asc(assignmentsTable.id)],
      with: { subjects: { columns: { name: true } }, classes: true },
    });
    const subs = new Map(
      (
        await this.db.query.assignment_submissions.findMany({
          where: and(
            eq(assignment_submissions.student_id, student.id),
            inArray(
              assignment_submissions.assignment_id,
              assignments.map((a) => a.id),
            ),
          ),
          orderBy: [asc(assignment_submissions.id)],
        })
      ).map((s) => [s.assignment_id, s]),
    );
    const now = Date.now();
    const rows = assignments.map((a) => {
      const sub = subs.get(a.id);
      const due = a.due_date;
      return {
        id: a.id,
        title: a.title,
        subject: a.subjects?.name ?? null,
        class: a.classes ? classLabel(a.classes) : null,
        due_date: due
          ? `${MONTHS[due.getUTCMonth()].slice(0, 3)} ${due.getUTCDate()}, ${due.getUTCFullYear()}`
          : null,
        max_marks: a.max_marks,
        status:
          sub?.status ?? (due && due.getTime() < now ? 'missed' : 'pending'),
        score: sub?.score ?? null,
        feedback: sub?.feedback ?? null,
        submitted_at: diffForHumans(sub?.submitted_at),
      };
    });
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      student: toModel('users', student),
      assignments: rows,
      totals: {
        total: rows.length,
        graded: count('graded'),
        submitted: count('submitted'),
        pending: count('pending'),
        missed: count('missed'),
      },
    };
  }
}
