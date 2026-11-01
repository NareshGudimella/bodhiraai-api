import { Inject, Injectable } from '@nestjs/common';
import { assertSeatFree, seatsUsed } from '../common/seats';
import { directSchoolId, individualSchool } from '../common/direct-school';
import {
  and,
  eq,
  gte,
  inArray,
  sql,
  isNull,
  lt,
  or,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import { ApiException, ValidationFailed } from '../common/http/api.exception';
import {
  dateString,
  diffForHumans,
  parseLaravelDate,
} from '../common/http/laravel';
import { Role, roleLabel } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc, containsCi, countOf, myAsc, myDesc } from '../db/helpers';
import {
  assignments,
  attendance,
  chapters,
  class_student,
  class_subject,
  classes as classesTable,
  lesson_progress,
  quiz_attempts,
  school_syllabus,
  schools,
  subjects as subjectsTable,
  users as usersTable,
} from '../db/schema';
import type { users } from '../db/types';
import { classLabel } from '../teacher/teacher.service';
import { TokenService } from '../auth/token.service';
import { RosterService } from '../teacher/roster.service';
import { signedFileUrl } from '../storage/file-url';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
/** Carbon format('M j'). */
export const monthDay = (d: Date) =>
  `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
/** Today's UTC date, `days` ago, as a DATE value. */
export const dayAgo = (days: number) => {
  const d = new Date(`${dateString(new Date())}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
};

const pct = (n: number, total: number) =>
  total > 0 ? Math.round((n / total) * 100) : 0;
/** `col = v`, or `col IS NULL` for null (Laravel's `where(col, null)`). */
export const eqOrNull = (col: AnyColumn, v: unknown): SQL =>
  v === null || v === undefined ? isNull(col) : eq(col, v);

/** One UTC day as a [start, end) range (whereDate). */
export const onDay = (col: AnyColumn, d: Date) =>
  and(gte(col, d), lt(col, new Date(d.getTime() + 86_400_000)))!;

/**
 * The users an admin manages: their school's. A super admin (no school) acts on
 * the users with no school, like legacy, plus (not in legacy) the members of
 * Bodhira Direct, the default school, which the Super Admin runs.
 */
export const adminUsers = (admin: users): SQL =>
  admin.school_id !== null
    ? eq(usersTable.school_id, admin.school_id)
    : admin.role === (Role.SuperAdmin as string)
      ? individualSchool(usersTable.school_id)
      : isNull(usersTable.school_id);

/** guardSameSchool for a user, letting a super admin manage Bodhira Direct members too (adminUsers). */
export async function guardSameSchoolUser(
  db: Db,
  admin: users,
  user: { school_id: bigint | null },
) {
  if (
    admin.school_id === null &&
    admin.role === (Role.SuperAdmin as string) &&
    user.school_id !== null &&
    user.school_id === (await directSchoolId(db))
  )
    return;
  guardSameSchool(admin, user);
}

/** `$model->school_id !== $admin->school_id` → 403 (null matches null, like PHP). */
export function guardSameSchool(
  admin: users,
  model: { school_id: bigint | null },
) {
  if (model.school_id !== admin.school_id) {
    throw new ApiException('Resource belongs to a different school.', 403);
  }
}

/**
 * classes.school_id is NOT NULL: for a super admin (no school) Laravel's
 * `where('school_id', null)` matches nothing, so match an impossible id.
 */
const classSchool = (sid: bigint | null) => sid ?? -1n;

/** DATE value for a validated date string. */
const dateValue = (v: unknown) =>
  typeof v === 'string'
    ? new Date(
        `${parseLaravelDate(v)!.stored.toISOString().slice(0, 10)}T00:00:00Z`,
      )
    : null;

/** Roles a school admin may create and re-assign (legacy `Rule::in`). */
export const EDITABLE_ROLES = [Role.Student, Role.Teacher, Role.Parent];

/** Port of App\Services\AdminService (school admin; super admins act on school_id NULL). */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly roster: RosterService,
    private readonly tokens: TokenService,
  ) {}

  private schoolStudents(admin: users) {
    return this.db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(adminUsers(admin), eq(usersTable.role, Role.Student)))
      .orderBy(asc(usersTable.id));
  }

  async dashboard(admin: users) {
    const sid = admin.school_id;
    const school = sid
      ? await this.db.query.schools.findFirst({ where: eq(schools.id, sid) })
      : null;
    const count = (role: Role) =>
      this.db.$count(
        usersTable,
        and(adminUsers(admin), eq(usersTable.role, role)),
      );
    const students = await count(Role.Student);
    const studentIds = (await this.schoolStudents(admin)).map((s) => s.id);
    const today = dayAgo(0);
    const presentToday = await this.db.$count(
      attendance,
      and(
        eq(attendance.date, today),
        inArray(attendance.student_id, studentIds),
        eq(attendance.status, 'present'),
      ),
    );
    const classIds = (
      await this.db
        .select({ id: classesTable.id })
        .from(classesTable)
        .where(eq(classesTable.school_id, classSchool(sid)))
        .orderBy(asc(classesTable.id))
    ).map((c) => c.id);
    const signups = await this.db.query.users.findMany({
      where: adminUsers(admin),
      orderBy: [myDesc(usersTable.created_at), asc(usersTable.id)],
      limit: 6,
    });
    const attempts = await this.db.query.quiz_attempts.findMany({
      where: and(
        inArray(quiz_attempts.student_id, studentIds),
        eq(quiz_attempts.status, 'submitted'),
      ),
      orderBy: [myDesc(quiz_attempts.submitted_at), asc(quiz_attempts.id)],
      limit: 5,
      with: {
        users: { columns: { name: true } },
        quizzes: { with: { subjects: { columns: { name: true } } } },
      },
    });

    return {
      admin: {
        name: admin.name,
        school: school?.name ?? null,
        school_code: school?.code ?? null,
      },
      stats: {
        students,
        teachers: await count(Role.Teacher),
        parents: await count(Role.Parent),
        classes: classIds.length,
        subjects: await this.db.$count(
          subjectsTable,
          eqOrNull(subjectsTable.school_id, sid),
        ),
        attendance_percent: pct(presentToday, students),
        active_assignments: await this.db.$count(
          assignments,
          and(
            inArray(assignments.class_id, classIds),
            eq(assignments.is_published, true),
          ),
        ),
      },
      recent_signups: signups.map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        role_label: roleLabel(u.role),
        created_at: diffForHumans(u.created_at),
      })),
      recent_attempts: attempts.map((a) => ({
        student: a.users?.name ?? null,
        quiz: a.quizzes?.title ?? null,
        subject: a.quizzes?.subjects?.name ?? null,
        score: a.score,
        total: a.total_marks,
        percent: pct(a.score, a.total_marks),
        submitted_at: diffForHumans(a.submitted_at),
      })),
    };
  }

  async paginatedUsers(
    admin: users,
    role: string | null,
    q: string | null,
    perPage: number,
    page: number,
  ) {
    const where = and(
      adminUsers(admin),
      role ? eq(usersTable.role, role) : undefined,
      q
        ? or(
            containsCi(usersTable.name, q),
            containsCi(usersTable.email, q),
            containsCi(usersTable.phone, q),
          )
        : undefined,
    );
    const [items, total] = await Promise.all([
      this.db.query.users.findMany({
        where,
        orderBy: [asc(usersTable.name), asc(usersTable.id)],
        offset: (page - 1) * perPage,
        limit: perPage,
      }),
      this.db.$count(usersTable, where),
    ]);
    return { items, total };
  }

  /** Web\\AdminController::seatInfo: seats used vs the caps the super admin set (null without a school). */
  async seatInfo(admin: users) {
    const school = admin.school_id
      ? await this.db.query.schools.findFirst({
          where: eq(schools.id, admin.school_id),
        })
      : null;
    if (!school) return null;
    const used = (role: Role.Teacher | Role.Student) =>
      seatsUsed(this.db, school.id, role);
    return {
      teachers_used: await used(Role.Teacher),
      teachers_max: Number(school.max_teachers),
      students_used: await used(Role.Student),
      students_max: Number(school.max_students),
    };
  }

  /**
   * Web\\AdminController::enforceSeatCap (not in the legacy API, which had no cap;
   * the web route did): a 422 on `role` once the school's cap is reached.
   */
  async enforceSeatCap(admin: users, role: string) {
    const seats = await this.seatInfo(admin);
    if (!seats) return;
    if (
      role === (Role.Teacher as string) &&
      seats.teachers_used >= seats.teachers_max
    ) {
      throw ValidationFailed.field(
        'role',
        `Teacher limit reached (${seats.teachers_max}). Contact the platform admin to raise it.`,
      );
    }
    if (
      role === (Role.Student as string) &&
      seats.students_used >= seats.students_max
    ) {
      throw ValidationFailed.field(
        'role',
        `Student limit reached (${seats.students_max}). Contact the platform admin to raise it.`,
      );
    }
  }

  /** AdminService::createUser (username: typed → normalised; students → generated). */
  async createUser(admin: users, data: Record<string, unknown>) {
    const s = (k: string) => (typeof data[k] === 'string' ? data[k] : null);
    const role = s('role')!;
    const explicit = (s('username') ?? '').trim();
    const username = explicit
      ? explicit.replace(/[^a-z0-9\-_.]/gi, '').toLowerCase()
      : role === (Role.Student as string)
        ? await this.roster.generateUsername(admin, s('name')!, s('grade'))
        : null;
    const now = new Date();
    const [row] = await this.db
      .insert(usersTable)
      .values({
        // not in legacy: a student a super admin adds joins Bodhira Direct.
        school_id:
          admin.school_id ??
          (admin.role === (Role.SuperAdmin as string) &&
          role === (Role.Student as string)
            ? await directSchoolId(this.db)
            : null),
        name: s('name')!,
        email: s('email'),
        phone: s('phone'),
        role,
        gender: s('gender'),
        grade: role === (Role.Student as string) ? s('grade') : null,
        dob: dateValue(data.dob),
        status: 'active',
        username,
        ...(s('password') && { password: await hashPassword(s('password')!) }),
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /** Only the validated keys among name/email/phone/role/gender/grade/dob, plus a new password. */
  async updateUser(admin: users, user: users, data: Record<string, unknown>) {
    await guardSameSchoolUser(this.db, admin, user);
    const fields: Record<string, unknown> = {};
    // Not in legacy: an admin / super admin account keeps its role (the edit
    // form locks the role select; legacy's `in:` rule also refused 'admin').
    const lockRole = !EDITABLE_ROLES.includes(user.role as Role);
    for (const k of [
      'name',
      'email',
      'phone',
      'role',
      'gender',
      'grade',
    ] as const) {
      if (k === 'role' && lockRole) continue;
      if (k in data) fields[k] = data[k];
    }
    if ('dob' in data) fields.dob = dateValue(data.dob);
    if (typeof data.password === 'string' && data.password)
      fields.password = await hashPassword(data.password);
    const [row] = await this.db
      .update(usersTable)
      .set({ ...fields, updated_at: new Date() })
      .where(eq(usersTable.id, user.id))
      .returning();
    return row;
  }

  async toggleUser(admin: users, user: users) {
    await guardSameSchoolUser(this.db, admin, user);
    // security: not in legacy — approving an on-hold account takes a seat.
    if (user.status === 'on_hold') {
      await assertSeatFree(this.db, user.school_id, user.role, 'status');
    }
    const [row] = await this.db
      .update(usersTable)
      .set({
        status: user.status === 'active' ? 'inactive' : 'active',
        updated_at: new Date(),
      })
      .where(eq(usersTable.id, user.id))
      .returning();
    // security: not in legacy — a deactivated user is signed out everywhere.
    if (row.status !== 'active') await this.tokens.revokeAllForUser(user.id);
    return row;
  }

  classes(admin: users) {
    return this.db.query.classes.findMany({
      where: eq(classesTable.school_id, classSchool(admin.school_id)),
      orderBy: [
        asc(classesTable.grade),
        asc(classesTable.section),
        asc(classesTable.id),
      ],
      with: { users: { columns: { name: true } } },
      extras: (t) => ({
        students_count: countOf(class_student, 'class_id', t.id).as(
          'students_count',
        ),
        subjects_count: countOf(class_subject, 'class_id', t.id).as(
          'subjects_count',
        ),
      }),
    });
  }

  /**
   * security: not in legacy — `exists:users,id` accepted any account. The user
   * must be an (optionally role-checked) member of the admin's own school.
   */
  private async assertSchoolUser(
    admin: users,
    id: bigint,
    role: Role,
    field: string,
    message: string,
  ) {
    const u = await this.db.query.users.findFirst({
      where: eq(usersTable.id, id),
      columns: { role: true, school_id: true },
    });
    if (
      !u ||
      !admin.school_id ||
      u.school_id !== admin.school_id ||
      u.role !== (role as string)
    ) {
      throw ValidationFailed.field(field, message);
    }
  }

  async createClass(admin: users, data: Record<string, unknown>) {
    if (data.class_teacher_id != null) {
      await this.assertSchoolUser(
        admin,
        BigInt(data.class_teacher_id as string | number),
        Role.Teacher,
        'class_teacher_id',
        'The selected class teacher must be a teacher of your school.',
      );
    }
    const now = new Date();
    const [row] = await this.db
      .insert(classesTable)
      .values({
        school_id: admin.school_id!,
        grade: data.grade as string,
        section: data.section as string,
        class_teacher_id:
          data.class_teacher_id == null
            ? null
            : BigInt(data.class_teacher_id as string | number),
        academic_year:
          (data.academic_year as string | null | undefined) ?? null,
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  async classDetail(admin: users, classId: bigint) {
    const c = await this.db.query.classes.findFirst({
      where: eq(classesTable.id, classId),
      with: {
        users: { columns: { name: true } },
        class_student: {
          orderBy: (t) => [asc(t.student_id), asc(t.id)],
          with: {
            users: {
              columns: { id: true, name: true, grade: true, avatar: true },
            },
          },
        },
        class_subject: {
          orderBy: (t) => [asc(t.subject_id), asc(t.id)],
          with: {
            subjects: {
              columns: { id: true, name: true, icon: true, grade: true },
            },
          },
        },
      },
    });
    if (!c) throw new Error('No classes found');
    guardSameSchool(admin, c);
    return {
      class: {
        id: c.id,
        label: classLabel(c),
        grade: c.grade,
        section: c.section,
        academic_year: c.academic_year,
        class_teacher: c.users?.name ?? null,
      },
      students: c.class_student.map((r) => ({
        id: r.users.id,
        name: r.users.name,
        roll_no: r.roll_no,
        // not in legacy API: the Blade class page shows grade and avatar
        grade: r.users.grade,
        avatar: signedFileUrl(r.users.avatar), // security: not in legacy: signed private-file link
      })),
      subjects: c.class_subject.map((r) => ({
        id: r.subjects.id,
        name: r.subjects.name,
        teacher_id: r.teacher_id,
        // not in legacy API: icon and grade, as the Blade class page shows
        icon: r.subjects.icon,
        grade: r.subjects.grade,
      })),
    };
  }

  /** syncWithoutDetaching: attach, or update the pivot of an existing link. */
  async enrol(
    admin: users,
    classSchool: { id: bigint; school_id: bigint },
    studentId: bigint,
    rollNo: string | null,
  ) {
    guardSameSchool(admin, classSchool);
    await this.assertSchoolUser(
      admin,
      studentId,
      Role.Student,
      'student_id',
      'The selected student must be a student of your school.',
    );
    const now = new Date();
    await this.db
      .insert(class_student)
      .values({
        class_id: classSchool.id,
        student_id: studentId,
        roll_no: rollNo,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [class_student.class_id, class_student.student_id],
        set: { roll_no: rollNo, updated_at: now },
      });
  }

  async unenrol(
    admin: users,
    classSchool: { id: bigint; school_id: bigint },
    studentId: bigint,
  ) {
    guardSameSchool(admin, classSchool);
    await this.db
      .delete(class_student)
      .where(
        and(
          eq(class_student.class_id, classSchool.id),
          eq(class_student.student_id, studentId),
        ),
      );
  }

  async linkSubject(
    admin: users,
    classSchool: { id: bigint; school_id: bigint },
    subjectId: bigint,
    teacherId: bigint | null,
  ) {
    guardSameSchool(admin, classSchool);
    // security: not in legacy — the subject must be the school's own, or a
    // syllabus subject (no school) of a syllabus the school opted into.
    const subject = await this.db.query.subjects.findFirst({
      where: eq(subjectsTable.id, subjectId),
      columns: { school_id: true, syllabus_id: true },
    });
    let allowed = false;
    if (subject && admin.school_id) {
      if (subject.school_id === admin.school_id) allowed = true;
      else if (subject.school_id === null && subject.syllabus_id !== null) {
        allowed = !!(await this.db.query.school_syllabus.findFirst({
          where: and(
            eq(school_syllabus.school_id, admin.school_id),
            eq(school_syllabus.syllabus_id, subject.syllabus_id),
          ),
          columns: { id: true },
          orderBy: [asc(school_syllabus.id)],
        }));
      }
    }
    if (!allowed) {
      throw ValidationFailed.field(
        'subject_id',
        'The selected subject is not available to your school.',
      );
    }
    if (teacherId !== null) {
      await this.assertSchoolUser(
        admin,
        teacherId,
        Role.Teacher,
        'teacher_id',
        'The selected teacher must be a teacher of your school.',
      );
    }
    const now = new Date();
    await this.db
      .insert(class_subject)
      .values({
        class_id: classSchool.id,
        subject_id: subjectId,
        teacher_id: teacherId,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [class_subject.class_id, class_subject.subject_id],
        set: { teacher_id: teacherId, updated_at: now },
      });
  }

  async unlinkSubject(
    admin: users,
    classSchool: { id: bigint; school_id: bigint },
    subjectId: bigint,
  ) {
    guardSameSchool(admin, classSchool);
    await this.db
      .delete(class_subject)
      .where(
        and(
          eq(class_subject.class_id, classSchool.id),
          eq(class_subject.subject_id, subjectId),
        ),
      );
  }

  subjects(admin: users) {
    return this.db.query.subjects.findMany({
      where: eqOrNull(subjectsTable.school_id, admin.school_id),
      orderBy: [
        myAsc(subjectsTable.grade),
        asc(subjectsTable.sort_order),
        asc(subjectsTable.name),
        asc(subjectsTable.id),
      ],
      extras: (t) => ({
        chapters_count: countOf(chapters, 'subject_id', t.id).as(
          'chapters_count',
        ),
      }),
    });
  }

  async analytics(admin: users) {
    const sid = admin.school_id;
    const classes = await this.db.query.classes.findMany({
      where: eq(classesTable.school_id, classSchool(sid)),
      orderBy: [asc(classesTable.id)],
      with: {
        class_student: {
          columns: { student_id: true },
          orderBy: (t) => [asc(t.id)],
        },
      },
    });
    // The school's students as a subquery, so their ids never travel to the API.
    const studentIds = this.schoolStudents(admin);
    const classIds = classes.map((c) => c.id);

    // Per class in two grouped queries (this was two queries per class, the first
    // loading every attendance row the class ever had).
    const attByClass = new Map<bigint, { total: number; present: number }>();
    const avgByClass = new Map<bigint, number>();
    if (classIds.length) {
      const att = await this.db
        .select({
          class_id: attendance.class_id,
          total: sql<number>`count(*)::int`,
          present: sql<number>`(count(*) filter (where ${attendance.status} = 'present'))::int`,
        })
        .from(attendance)
        .where(inArray(attendance.class_id, classIds))
        .groupBy(attendance.class_id);
      att.forEach((a) => attByClass.set(a.class_id, a));
      // avgPct() in SQL: the same float8 operations summed in attempt-id order, so
      // the rounded result matches the per-row JS version exactly.
      const avgs = await this.db
        .select({
          class_id: class_student.class_id,
          sum: sql<number>`sum(case when ${quiz_attempts.total_marks} > 0 then (${quiz_attempts.score}::float8 / ${quiz_attempts.total_marks}) * 100 else 0 end order by ${quiz_attempts.id})`,
          n: sql<number>`count(*)::int`,
        })
        .from(quiz_attempts)
        .innerJoin(
          class_student,
          eq(class_student.student_id, quiz_attempts.student_id),
        )
        .where(
          and(
            inArray(class_student.class_id, classIds),
            eq(quiz_attempts.status, 'submitted'),
          ),
        )
        .groupBy(class_student.class_id);
      avgs.forEach((a) =>
        avgByClass.set(a.class_id, Math.round(Number(a.sum) / a.n)),
      );
    }
    const rows = classes.map((c) => {
      const a = attByClass.get(c.id);
      return {
        id: c.id,
        label: classLabel(c),
        students: c.class_student.length,
        attendance_percent: pct(a?.present ?? 0, a?.total ?? 0),
        avg_quiz_percent: avgByClass.get(c.id) ?? 0,
      };
    });

    // The last 7 days in one grouped query (was two counts per day).
    const days = Array.from({ length: 7 }, (_, k) => dayAgo(6 - k));
    const byDay = new Map(
      (
        await this.db
          .select({
            date: attendance.date,
            total: sql<number>`count(*)::int`,
            present: sql<number>`(count(*) filter (where ${attendance.status} = 'present'))::int`,
          })
          .from(attendance)
          .where(
            and(
              gte(attendance.date, days[0]),
              lt(attendance.date, dayAgo(-1)),
              inArray(attendance.student_id, studentIds),
            ),
          )
          .groupBy(attendance.date)
      ).map((d) => [dateString(new Date(d.date)), d]),
    );
    const trend = days.map((date) => {
      const d = byDay.get(dateString(date));
      return {
        date: monthDay(date),
        percent: pct(d?.present ?? 0, d?.total ?? 0),
      };
    });

    const classAvg = rows.length
      ? rows.reduce((n, r) => n + r.avg_quiz_percent, 0) / rows.length
      : 0;
    return {
      classes: rows,
      attendance_trend: trend,
      totals: {
        lessons_completed: await this.db.$count(
          lesson_progress,
          and(
            inArray(lesson_progress.student_id, studentIds),
            eq(lesson_progress.status, 'completed'),
          ),
        ),
        quiz_attempts: await this.db.$count(
          quiz_attempts,
          and(
            inArray(quiz_attempts.student_id, studentIds),
            eq(quiz_attempts.status, 'submitted'),
          ),
        ),
        avg_quiz_percent: classAvg ? Math.round(classAvg) : 0,
      },
    };
  }
}
