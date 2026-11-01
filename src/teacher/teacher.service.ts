import { Inject, Injectable } from '@nestjs/common';
import { and, eq, exists, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { ApiException, ValidationFailed } from '../common/http/api.exception';
import { toModel, withPivot } from '../common/http/eloquent';
import {
  dateString,
  diffForHumans,
  forbidden,
  iso8601,
  modelNotFound,
} from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { asc, countOf, myDesc } from '../db/helpers';
import {
  assignment_submissions,
  assignments as assignmentsTable,
  attendance,
  chapters,
  class_student,
  class_subject,
  classes as classesTable,
  questions,
  quiz_attempts,
  quizzes as quizzesTable,
  schools,
  subjects,
  users as usersTable,
} from '../db/schema';
import type { assignments, classes, quizzes, users } from '../db/types';
import { NotificationService } from '../notification/notification.service';

/** Klass::getLabelAttribute(). */
export const classLabel = (c: Pick<classes, 'grade' | 'section'>) =>
  `Grade ${c.grade} - ${c.section}`;

const webUrl = (path: string) =>
  `${(process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '')}${path}`;

const percent = (score: number, total: number) =>
  total > 0 ? Math.round((score / total) * 100) : 0;

/** PHP sortBy on strings: byte-wise comparison, stable. */
const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const STUDENT_PIVOT = {
  foreign: 'class_id',
  related: 'student_id',
  columns: ['roll_no'],
};
const SUBJECT_PIVOT = {
  foreign: 'class_id',
  related: 'subject_id',
  columns: ['teacher_id'],
};

/** Port of App\Services\TeacherService (API parts). */
@Injectable()
export class TeacherService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationService,
  ) {}

  // ── Classes ──

  private async assignedClassIds(teacher: users) {
    const rows = await this.db.query.class_subject.findMany({
      where: eq(class_subject.teacher_id, teacher.id),
      columns: { class_id: true },
      orderBy: [asc(class_subject.id)],
    });
    return rows.map((r) => r.class_id);
  }

  /** Owned classes first, then subject-assigned ones, de-duplicated. */
  async classIdsFor(teacher: users) {
    const owned = await this.db.query.classes.findMany({
      where: eq(classesTable.class_teacher_id, teacher.id),
      columns: { id: true },
      orderBy: [asc(classesTable.id)],
    });
    return [
      ...new Set([
        ...owned.map((c) => c.id),
        ...(await this.assignedClassIds(teacher)),
      ]),
    ];
  }

  async classesTaught(teacher: users) {
    const assigned = await this.assignedClassIds(teacher);
    return this.db.query.classes.findMany({
      where: or(
        eq(classesTable.class_teacher_id, teacher.id),
        inArray(classesTable.id, assigned),
      ),
      orderBy: [
        asc(classesTable.grade),
        asc(classesTable.section),
        asc(classesTable.id),
      ],
      extras: (t) => ({
        students_count: countOf(class_student, 'class_id', t.id).as(
          'students_count',
        ),
      }),
    });
  }

  /** Not in legacy's API: class teacher names for the class cards (legacy's classes page showed them). */
  async classTeacherNames(rows: classes[]) {
    const ids = [
      ...new Set(rows.map((c) => c.class_teacher_id).filter((i) => i !== null)),
    ] as bigint[];
    if (!ids.length) return new Map<bigint, string>();
    const teachers = await this.db.query.users.findMany({
      where: inArray(usersTable.id, ids),
      columns: { id: true, name: true },
    });
    return new Map(teachers.map((t) => [t.id, t.name]));
  }

  async findClass(id: bigint) {
    const c = await this.db.query.classes.findFirst({
      where: eq(classesTable.id, id),
    });
    if (!c) throw modelNotFound('Klass', id);
    return c;
  }

  async teachesClass(teacher: users, c: classes) {
    if (c.class_teacher_id === teacher.id) return true;
    return !!(await this.db.query.class_subject.findFirst({
      where: and(
        eq(class_subject.class_id, c.id),
        eq(class_subject.teacher_id, teacher.id),
      ),
      columns: { id: true },
      orderBy: [asc(class_subject.id)],
    }));
  }

  async guardClass(teacher: users, c: classes) {
    if (!(await this.teachesClass(teacher, c))) {
      throw new ApiException('You do not teach this class.', 403);
    }
  }

  /** `$class->students` in relation order, as [user, pivot] pairs. */
  private roster(classId: bigint) {
    return this.db.query.class_student.findMany({
      where: eq(class_student.class_id, classId),
      orderBy: [asc(class_student.student_id), asc(class_student.id)],
      with: { users: true },
    });
  }

  /** Submissions to the teacher's assignments (`whereHas('assignment', …)`). */
  private ofTeacher(teacher: users) {
    return exists(
      this.db
        .select({ x: sql`1` })
        .from(assignmentsTable)
        .where(
          and(
            eq(assignmentsTable.id, assignment_submissions.assignment_id),
            eq(assignmentsTable.teacher_id, teacher.id),
          ),
        ),
    );
  }

  async dashboard(teacher: users) {
    const classIds = await this.classIdsFor(teacher);
    const students = await this.db
      .selectDistinct({ student_id: class_student.student_id })
      .from(class_student)
      .where(inArray(class_student.class_id, classIds));
    const pendingGrading = await this.db.$count(
      assignment_submissions,
      and(this.ofTeacher(teacher), isNull(assignment_submissions.graded_at)),
    );
    const assignmentsActive = await this.db.$count(
      assignmentsTable,
      and(
        eq(assignmentsTable.teacher_id, teacher.id),
        eq(assignmentsTable.is_published, true),
        or(
          isNull(assignmentsTable.due_date),
          gte(assignmentsTable.due_date, new Date()),
        ),
      ),
    );
    const quizzesPublished = await this.db.$count(
      quizzesTable,
      and(
        eq(quizzesTable.created_by, teacher.id),
        eq(quizzesTable.is_published, true),
      ),
    );
    const today = new Date(`${dateString(new Date())}T00:00:00Z`);
    const attendanceToday = await this.db.$count(
      attendance,
      and(inArray(attendance.class_id, classIds), eq(attendance.date, today)),
    );
    // Not in legacy: today's real attendance percentage (present records ÷ enrolments in the teacher's classes).
    const presentToday = await this.db.$count(
      attendance,
      and(
        inArray(attendance.class_id, classIds),
        eq(attendance.date, today),
        eq(attendance.status, 'present'),
      ),
    );
    const enrolments = await this.db.$count(
      class_student,
      inArray(class_student.class_id, classIds),
    );
    const recent = await this.db.query.assignment_submissions.findMany({
      where: this.ofTeacher(teacher),
      orderBy: [
        myDesc(assignment_submissions.submitted_at),
        asc(assignment_submissions.id),
      ],
      limit: 5,
      with: {
        assignments: { with: { classes: true } },
        users_assignment_submissions_student_idTousers: {
          columns: { name: true },
        },
      },
    });
    const school = teacher.school_id
      ? await this.db.query.schools.findFirst({
          where: eq(schools.id, teacher.school_id),
        })
      : null;
    const classes = (await this.classesTaught(teacher)).slice(0, 6);

    return {
      teacher: {
        id: teacher.id,
        name: teacher.name,
        school: school?.name ?? null,
      },
      stats: {
        classes_count: classIds.length,
        students_count: students.length,
        pending_grading: pendingGrading,
        assignments_active: assignmentsActive,
        quizzes_published: quizzesPublished,
        attendance_today: attendanceToday,
        attendance_today_percent: percent(presentToday, enrolments),
      },
      classes: classes.map((c) => ({
        id: c.id,
        label: classLabel(c),
        students_count: c.students_count,
      })),
      recent_submissions: recent.map((s) => ({
        id: s.id,
        // Not in legacy: lets the app open the assignment behind a submission.
        assignment_id: s.assignment_id,
        assignment_title: s.assignments?.title ?? null,
        student: s.users_assignment_submissions_student_idTousers?.name ?? null,
        class: s.assignments?.classes
          ? classLabel(s.assignments.classes)
          : null,
        status: s.status,
        submitted_at: diffForHumans(s.submitted_at),
        graded: !!s.graded_at,
      })),
    };
  }

  async classDetail(c: classes) {
    const roster = await this.roster(c.id);
    const subjects = await this.db.query.class_subject.findMany({
      where: eq(class_subject.class_id, c.id),
      orderBy: [asc(class_subject.subject_id), asc(class_subject.id)],
      with: { subjects: true },
    });
    const classTeacher = c.class_teacher_id
      ? await this.db.query.users.findFirst({
          where: eq(usersTable.id, c.class_teacher_id),
        })
      : null;

    const total = await this.db.$count(
      attendance,
      eq(attendance.class_id, c.id),
    );
    const present = await this.db.$count(
      attendance,
      and(eq(attendance.class_id, c.id), eq(attendance.status, 'present')),
    );
    const assignments = await this.db.query.assignments.findMany({
      where: eq(assignmentsTable.class_id, c.id),
      orderBy: [myDesc(assignmentsTable.created_at), asc(assignmentsTable.id)],
      limit: 5,
    });
    const scores = await this.db.query.quiz_attempts.findMany({
      where: and(
        inArray(
          quiz_attempts.student_id,
          roster.map((r) => r.student_id),
        ),
        eq(quiz_attempts.status, 'submitted'),
      ),
      orderBy: [myDesc(quiz_attempts.submitted_at), asc(quiz_attempts.id)],
      limit: 8,
      with: { users: { columns: { name: true } } },
    });

    return {
      class: toModel('classes', c, {
        students: roster.map((r) =>
          withPivot('users', r.users, r, STUDENT_PIVOT),
        ),
        subjects: subjects.map((r) =>
          withPivot('subjects', r.subjects, r, SUBJECT_PIVOT),
        ),
        class_teacher: classTeacher ? toModel('users', classTeacher) : null,
      }),
      stats: {
        students: roster.length,
        subjects: subjects.length,
        attendance_percent: percent(present, total),
        assignments_count: await this.db.$count(
          assignmentsTable,
          eq(assignmentsTable.class_id, c.id),
        ),
      },
      assignments: assignments.map((a) => toModel('assignments', a)),
      recent_scores: scores.map((a) => ({
        student: a.users?.name ?? null,
        score: a.score,
        total: a.total_marks,
        percent: percent(a.score, a.total_marks),
        submitted_at: diffForHumans(a.submitted_at),
      })),
    };
  }

  // ── Attendance ──

  async attendanceFor(c: classes, date: Date) {
    const existing = await this.db.query.attendance.findMany({
      where: and(eq(attendance.class_id, c.id), eq(attendance.date, date)),
      columns: { student_id: true, status: true },
      orderBy: [asc(attendance.id)],
    });
    const status = new Map(existing.map((e) => [e.student_id, e.status]));
    const rows = await this.db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        roll_no: class_student.roll_no,
      })
      .from(class_student)
      .innerJoin(usersTable, eq(usersTable.id, class_student.student_id))
      .where(eq(class_student.class_id, c.id))
      .orderBy(asc(usersTable.name), asc(usersTable.id));
    return {
      class: toModel('classes', c),
      date: dateString(date),
      records: rows.map((r) => ({
        student_id: r.id,
        name: r.name,
        roll_no: r.roll_no,
        status: status.get(r.id) ?? null,
      })),
    };
  }

  /** updateOrCreate per record; updated_at only changes when the row changes (Eloquent dirty check). */
  async saveAttendance(
    c: classes,
    teacher: users,
    date: Date,
    records: Record<string, string>,
  ) {
    // security: not in legacy — only students (role student) enrolled in this class can be marked.
    const enrolled = new Set(
      (
        await this.db
          .select({ id: class_student.student_id })
          .from(class_student)
          .innerJoin(usersTable, eq(usersTable.id, class_student.student_id))
          .where(
            and(
              eq(class_student.class_id, c.id),
              eq(usersTable.role, 'student'),
            ),
          )
      ).map((r) => String(r.id)),
    );
    for (const studentId of Object.keys(records)) {
      if (!/^\d+$/.test(studentId) || !enrolled.has(studentId)) {
        throw ValidationFailed.field(
          'records',
          'One or more students are not enrolled in this class.',
        );
      }
    }
    let saved = 0;
    const now = new Date();
    for (const [studentId, status] of Object.entries(records)) {
      if (!['present', 'absent', 'late', 'excused'].includes(status)) continue;
      const key = {
        class_id: c.id,
        student_id: BigInt(parseInt(studentId, 10) || 0),
        date,
      };
      const row = await this.db.query.attendance.findFirst({
        where: and(
          eq(attendance.class_id, key.class_id),
          eq(attendance.student_id, key.student_id),
          eq(attendance.date, key.date),
        ),
      });
      if (!row) {
        await this.db.insert(attendance).values({
          ...key,
          status,
          marked_by: teacher.id,
          created_at: now,
          updated_at: now,
        });
      } else if (row.status !== status || row.marked_by !== teacher.id) {
        await this.db
          .update(attendance)
          .set({ status, marked_by: teacher.id, updated_at: now })
          .where(eq(attendance.id, row.id));
      }
      saved++;
    }
    return saved;
  }

  // ── Assignments ──

  assignmentsByTeacher(teacher: users) {
    return this.db.query.assignments.findMany({
      where: eq(assignmentsTable.teacher_id, teacher.id),
      orderBy: [myDesc(assignmentsTable.created_at), asc(assignmentsTable.id)],
      with: {
        classes: true,
        subjects: { columns: { name: true } },
      },
      extras: (t) => ({
        submissions_count: countOf(
          assignment_submissions,
          'assignment_id',
          t.id,
        ).as('submissions_count'),
      }),
    });
  }

  /**
   * Assignment::create + AssignmentPublished to the class. `data` holds the
   * validated request values; the notification echoes them as sent, like legacy.
   */
  async createAssignment(
    teacher: users,
    data: Record<string, unknown>,
    dueDate: Date | null,
  ) {
    const now = new Date();
    const [a] = await this.db
      .insert(assignmentsTable)
      .values({
        teacher_id: teacher.id,
        is_published: true,
        class_id: BigInt(data.class_id as string | number),
        ...('subject_id' in data && {
          subject_id:
            data.subject_id === null
              ? null
              : BigInt(data.subject_id as string | number),
        }),
        title: data.title as string,
        ...('description' in data && {
          description: data.description as string | null,
        }),
        ...('attachment_url' in data && {
          attachment_url: data.attachment_url as string | null,
        }),
        ...('due_date' in data && { due_date: dueDate }),
        max_marks: Number(data.max_marks),
        created_at: now,
        updated_at: now,
      })
      .returning();

    const students = await this.db.query.class_student.findMany({
      where: eq(class_student.class_id, a.class_id),
      orderBy: [asc(class_student.student_id), asc(class_student.id)],
      columns: { student_id: true },
    });
    await this.notifications.notifyMany(
      students.map((s) => s.student_id),
      'AssignmentPublished',
      {
        type: 'assignment.published',
        icon: '📝',
        title: 'New assignment',
        body: a.title,
        meta: {
          assignment_id: Number(a.id),
          class_id: data.class_id,
          due_date: iso8601(a.due_date),
          max_marks: data.max_marks,
        },
        url: webUrl(`/student/assignments/${a.id}`),
      },
    );
    return a;
  }

  async ownAssignment(teacher: users, id: bigint) {
    const a = await this.db.query.assignments.findFirst({
      where: eq(assignmentsTable.id, id),
    });
    if (!a) throw modelNotFound('Assignment', id);
    if (a.teacher_id !== teacher.id) throw forbidden();
    return a;
  }

  async assignmentDetail(a: assignments) {
    const klass = await this.db.query.classes.findFirst({
      where: eq(classesTable.id, a.class_id),
    });
    if (!klass) throw new Error('No classes found');
    const roster = await this.roster(a.class_id);
    const subject = a.subject_id
      ? await this.db.query.subjects.findFirst({
          where: eq(subjects.id, a.subject_id),
        })
      : null;
    const submissions = await this.db.query.assignment_submissions.findMany({
      where: eq(assignment_submissions.assignment_id, a.id),
      orderBy: [asc(assignment_submissions.id)],
      with: { users_assignment_submissions_student_idTousers: true },
    });
    const byStudent = new Map(submissions.map((s) => [s.student_id, s]));

    return {
      assignment: toModel('assignments', a, {
        klass: toModel('classes', klass, {
          students: roster.map((r) =>
            withPivot('users', r.users, r, STUDENT_PIVOT),
          ),
        }),
        subject: subject ? toModel('subjects', subject) : null,
        submissions: submissions.map((s) =>
          toModel('assignment_submissions', s, {
            student: toModel(
              'users',
              s.users_assignment_submissions_student_idTousers,
            ),
          }),
        ),
      }),
      roster: [...roster.map((r) => r.users)].sort(byName).map((student) => {
        const sub = byStudent.get(student.id);
        return {
          student_id: student.id,
          name: student.name,
          submission_id: sub?.id ?? null,
          status: sub?.status ?? 'pending',
          score: sub?.score ?? null,
          submitted_at: diffForHumans(sub?.submitted_at),
          graded: !!sub?.graded_at,
        };
      }),
    };
  }

  async ownSubmission(teacher: users, id: bigint) {
    const s = await this.db.query.assignment_submissions.findFirst({
      where: eq(assignment_submissions.id, id),
      with: { assignments: true },
    });
    if (!s) throw modelNotFound('AssignmentSubmission', id);
    if (s.assignments?.teacher_id !== teacher.id) throw forbidden();
    return s;
  }

  async gradeSubmission(
    sub: Awaited<ReturnType<TeacherService['ownSubmission']>>,
    teacher: users,
    score: number,
    feedback: string | null,
  ) {
    const now = new Date();
    const [graded] = await this.db
      .update(assignment_submissions)
      .set({
        score: Math.max(0, score),
        feedback,
        status: 'graded',
        graded_by: teacher.id,
        graded_at: now,
        updated_at: now,
      })
      .where(eq(assignment_submissions.id, sub.id))
      .returning();
    const a = sub.assignments;
    await this.notifications.notifyMany([sub.student_id], 'SubmissionGraded', {
      type: 'submission.graded',
      icon: '✅',
      title: 'Assignment graded',
      body: `${a?.title ?? ''} — ${graded.score}/${a?.max_marks ?? ''}`,
      meta: {
        submission_id: Number(graded.id),
        assignment_id: Number(graded.assignment_id),
        score: graded.score,
        max_marks: a?.max_marks ?? null,
      },
      url: webUrl(`/student/assignments/${graded.assignment_id}`),
    });
    return graded;
  }

  // ── Quizzes ──

  quizzesByTeacher(teacher: users) {
    return this.db.query.quizzes.findMany({
      where: eq(quizzesTable.created_by, teacher.id),
      orderBy: [myDesc(quizzesTable.created_at), asc(quizzesTable.id)],
      with: {
        subjects: { columns: { name: true } },
        chapters: { columns: { title: true } },
      },
      extras: (t) => ({
        questions_count: countOf(questions, 'quiz_id', t.id).as(
          'questions_count',
        ),
        attempts_count: countOf(quiz_attempts, 'quiz_id', t.id).as(
          'attempts_count',
        ),
      }),
    });
  }

  async ownQuiz(teacher: users, id: bigint) {
    const q = await this.db.query.quizzes.findFirst({
      where: eq(quizzesTable.id, id),
    });
    if (!q) throw modelNotFound('Quiz', id);
    if (q.created_by !== teacher.id) throw forbidden();
    return q;
  }

  async quizAnalytics(q: quizzes) {
    const attempts = await this.db.query.quiz_attempts.findMany({
      where: and(
        eq(quiz_attempts.quiz_id, q.id),
        eq(quiz_attempts.status, 'submitted'),
      ),
      orderBy: [asc(quiz_attempts.id)],
      with: { users: { columns: { name: true } } },
    });
    const subject = q.subject_id
      ? await this.db.query.subjects.findFirst({
          where: eq(subjects.id, q.subject_id),
        })
      : null;
    const chapter = q.chapter_id
      ? await this.db.query.chapters.findFirst({
          where: eq(chapters.id, q.chapter_id),
        })
      : null;
    const total = attempts.length;
    const avg = total
      ? Math.round(
          attempts.reduce(
            (n, a) =>
              n + (a.total_marks > 0 ? (a.score / a.total_marks) * 100 : 0),
            0,
          ) / total,
        )
      : 0;
    const passed = attempts.filter((a) => a.score >= q.pass_marks).length;
    const time = (d: Date | null) => d?.getTime() ?? -Infinity;

    return {
      quiz: toModel('quizzes', q, {
        subject: subject ? toModel('subjects', subject) : null,
        chapter: chapter ? toModel('chapters', chapter) : null,
      }),
      stats: {
        attempts: total,
        avg_percent: avg,
        pass_rate: percent(passed, total),
        highest: total ? Math.max(...attempts.map((a) => a.score)) : 0,
        lowest: total ? Math.min(...attempts.map((a) => a.score)) : 0,
      },
      attempts: [...attempts]
        .sort((a, b) => time(b.submitted_at) - time(a.submitted_at))
        .map((a) => ({
          id: a.id,
          student: a.users?.name ?? null,
          score: a.score,
          total: a.total_marks,
          percent: percent(a.score, a.total_marks),
          submitted_at: diffForHumans(a.submitted_at),
        })),
    };
  }
}
