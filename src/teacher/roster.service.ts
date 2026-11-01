import { Inject, Injectable } from '@nestjs/common';
import { assertSeatFree, seatsUsed } from '../common/seats';
import { and, eq, inArray } from 'drizzle-orm';
import { toModel } from '../common/http/eloquent';
import { ValidationFailed } from '../common/http/api.exception';
import {
  diffForHumans,
  forbidden,
  modelNotFound,
} from '../common/http/laravel';
import { Role } from '../common/roles';
import { hashPassword } from '../auth/password';
import { TokenService } from '../auth/token.service';
import { DB, type Db } from '../db/db';
import { asc, countOf, myDesc } from '../db/helpers';
import {
  ai_chat_messages,
  ai_chat_sessions,
  class_student,
  parent_student,
  schools,
  users as usersTable,
} from '../db/schema';
import type { classes, users } from '../db/types';
import { ParentService } from '../parent/parent.service';
import { strRandom, strSlug } from '../storage/laravel-str';
import { StorageService } from '../storage/storage.service';
import { TeacherService } from './teacher.service';
import { signedFileUrl } from '../storage/file-url';

export interface StudentInput {
  name: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  dob: Date | null;
  password: string | null;
  roll_no: string | null;
  avatarUrl?: string;
}

/**
 * Class roster management and the teacher's student profile. Ports of the
 * legacy web TeacherController (storeStudent / updateStudent / studentStatus /
 * removeStudent / student), AdminService::createUser and
 * TeacherService::studentProfile. Not in the legacy API.
 */
@Injectable()
export class RosterService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly teachers: TeacherService,
    private readonly parents: ParentService,
    private readonly storage: StorageService,
    private readonly tokens: TokenService,
  ) {}

  async findStudent(id: bigint) {
    const s = await this.db.query.users.findFirst({
      where: eq(usersTable.id, id),
    });
    if (!s) throw modelNotFound('User', id);
    return s;
  }

  /** security: not in legacy — role=student in the teacher's school (a school-less teacher matches nobody). */
  isOwnStudent(teacher: users, student: users) {
    return (
      student.role === (Role.Student as string) &&
      teacher.school_id !== null &&
      student.school_id === teacher.school_id
    );
  }

  /** Legacy guardStudent: the teacher must teach the class, and the student must be in it (else 404). */
  async enrolment(teacher: users, c: classes, student: users) {
    await this.teachers.guardClass(teacher, c);
    // security: not in legacy — the roster only ever touches students of the
    // teacher's own school; any other user looks like a missing record.
    if (!this.isOwnStudent(teacher, student)) {
      throw modelNotFound('User', student.id);
    }
    const row = await this.db.query.class_student.findFirst({
      where: and(
        eq(class_student.class_id, c.id),
        eq(class_student.student_id, student.id),
      ),
    });
    if (!row) throw modelNotFound('User', student.id);
    return row;
  }

  /** AdminService::generateStudentUsername: `<school code>-<grade>-<name slug>`, then -01, -02, … */
  async generateUsername(teacher: users, name: string, grade: string | null) {
    const school = teacher.school_id
      ? await this.db.query.schools.findFirst({
          where: eq(schools.id, teacher.school_id),
          columns: { code: true },
        })
      : null;
    const code = (school?.code ?? 'bdh000').toLowerCase();
    const slug = [...strSlug(name)].slice(0, 18).join('');
    const base = `${code}-${grade ? grade.toLowerCase() : 'g'}-${slug}`;
    const taken = async (u: string) =>
      !!(await this.db.query.users.findFirst({
        where: eq(usersTable.username, u),
        columns: { id: true },
      }));
    let candidate = base;
    for (let i = 1; await taken(candidate); i++) {
      if (i > 99) return `${base}-${strRandom(4)}`;
      candidate = `${base}-${String(i).padStart(2, '0')}`;
    }
    return candidate;
  }

  async addStudent(teacher: users, c: classes, input: StudentInput) {
    // The school's seat cap, set by the platform admin.
    if (teacher.school_id) {
      const school = await this.db.query.schools.findFirst({
        where: eq(schools.id, teacher.school_id),
      });
      const count = await seatsUsed(this.db, teacher.school_id, Role.Student);
      if (school && count >= school.max_students) {
        throw new ValidationFailed({
          name: [
            `Student limit reached (${school.max_students}). Contact your school admin to raise it.`,
          ],
        });
      }
    }
    const now = new Date();
    const [student] = await this.db
      .insert(usersTable)
      .values({
        school_id: teacher.school_id,
        name: input.name,
        email: input.email,
        phone: input.phone,
        role: Role.Student,
        gender: input.gender,
        grade: c.grade,
        dob: input.dob,
        status: 'active',
        username: await this.generateUsername(teacher, input.name, c.grade),
        ...(input.password && { password: await hashPassword(input.password) }),
        ...(input.avatarUrl && { avatar: input.avatarUrl }),
        created_at: now,
        updated_at: now,
      })
      .returning();
    // syncWithoutDetaching: enrol once, with the roll number.
    await this.db
      .insert(class_student)
      .values({
        class_id: c.id,
        student_id: student.id,
        roll_no: input.roll_no,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [class_student.class_id, class_student.student_id],
        set: { roll_no: input.roll_no, updated_at: now },
      });
    return student;
  }

  async updateStudent(c: classes, student: users, input: StudentInput) {
    const now = new Date();
    const [updated] = await this.db
      .update(usersTable)
      .set({
        name: input.name,
        email: input.email,
        phone: input.phone,
        gender: input.gender,
        dob: input.dob,
        ...(input.password && { password: await hashPassword(input.password) }),
        ...(input.avatarUrl && { avatar: input.avatarUrl }),
        updated_at: now,
      })
      .where(eq(usersTable.id, student.id))
      .returning();
    if (input.avatarUrl) await this.storage.delete(student.avatar);
    await this.db
      .update(class_student)
      .set({ roll_no: input.roll_no, updated_at: now })
      .where(
        and(
          eq(class_student.class_id, c.id),
          eq(class_student.student_id, student.id),
        ),
      );
    return updated;
  }

  async setStatus(student: users, status: string) {
    // security: not in legacy — taking a student off hold takes a seat again.
    if (student.status === 'on_hold' && status !== 'on_hold') {
      await assertSeatFree(
        this.db,
        student.school_id,
        student.role,
        'status',
        'school admin',
      );
    }
    const [updated] = await this.db
      .update(usersTable)
      .set({ status, updated_at: new Date() })
      .where(eq(usersTable.id, student.id))
      .returning();
    // security: not in legacy — a blocked or on-hold student is signed out everywhere.
    if (status !== 'active') await this.tokens.revokeAllForUser(student.id);
    return updated;
  }

  /** Legacy deletes the student's whole account (rows cascade in the DB). */
  async remove(student: users) {
    await this.db.delete(usersTable).where(eq(usersTable.id, student.id));
    await this.storage.delete(student.avatar);
  }

  /** TeacherService::teachesStudent: the student is in any class the teacher teaches. */
  async guardTeaches(teacher: users, student: users) {
    // security: not in legacy — students of the teacher's school only.
    if (!this.isOwnStudent(teacher, student)) throw forbidden();
    const classIds = await this.teachers.classIdsFor(teacher);
    const shared = classIds.length
      ? await this.db.query.class_student.findFirst({
          where: and(
            eq(class_student.student_id, student.id),
            inArray(class_student.class_id, classIds),
          ),
          columns: { id: true },
          orderBy: [asc(class_student.id)],
        })
      : null;
    if (!shared) throw forbidden();
  }

  /** TeacherService::studentProfile. */
  async profile(student: users) {
    const overview = await this.parents.childOverview(student);
    const performance = await this.parents.childPerformance(student);
    const attendance = await this.parents.childAttendance(student);
    const sessions = await this.db.query.ai_chat_sessions.findMany({
      where: eq(ai_chat_sessions.user_id, student.id),
      orderBy: [
        myDesc(ai_chat_sessions.last_message_at),
        myDesc(ai_chat_sessions.updated_at),
        asc(ai_chat_sessions.id),
      ],
      limit: 12,
      extras: (t) => ({
        messages_count: countOf(ai_chat_messages, 'session_id', t.id).as(
          'messages_count',
        ),
      }),
    });
    const parents = await this.db.query.parent_student.findMany({
      where: eq(parent_student.student_id, student.id),
      orderBy: [asc(parent_student.parent_id), asc(parent_student.id)],
      with: { users_parent_student_parent_idTousers: true },
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
      stats: overview.stats,
      recent_lessons: overview.recent_lessons,
      recent_quizzes: overview.recent_quizzes,
      subjects: performance.by_subject,
      overall_avg: performance.overall_avg,
      attendance,
      ai_activity: sessions.map((s) => ({
        id: s.id,
        title: s.title || 'Untitled chat',
        mode: s.mode,
        messages_count: s.messages_count,
        last_at: diffForHumans(s.last_message_at ?? s.updated_at),
      })),
      parents: parents.map((p) => ({
        id: p.users_parent_student_parent_idTousers.id,
        name: p.users_parent_student_parent_idTousers.name,
        avatar: signedFileUrl(p.users_parent_student_parent_idTousers.avatar), // security: not in legacy: signed private-file link
        relation: p.relation,
        phone: p.users_parent_student_parent_idTousers.phone,
        email: p.users_parent_student_parent_idTousers.email,
      })),
    };
  }
}
