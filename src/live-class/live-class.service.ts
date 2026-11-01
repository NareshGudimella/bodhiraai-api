import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { ApiException, ValidationFailed } from '../common/http/api.exception';
import { iso8601, modelNotFound } from '../common/http/laravel';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { schoolOf } from '../common/direct-school';
import { countOf } from '../db/helpers';
import {
  class_student,
  class_subject,
  classes as classesTable,
  live_class_attendees,
  live_classes as liveClassesTable,
  school_syllabus as schoolSyllabus,
  subjects as subjectsTable,
  users as usersTable,
} from '../db/schema';
import type { live_classes, users } from '../db/types';
import { NotificationService } from '../notification/notification.service';

/** Public Jitsi server; anyone with the room URL can join. */
export const JITSI_HOST = 'https://meet.jit.si';

export type LiveStatus = 'cancelled' | 'scheduled' | 'live' | 'ended';

/** LiveClass::getLiveStatusAttribute(). */
export function liveStatus(lc: live_classes, now = Date.now()): LiveStatus {
  if (lc.status === 'cancelled') return 'cancelled';
  const start = lc.scheduled_at.getTime();
  if (now < start) return 'scheduled';
  if (now <= start + lc.duration_min * 60_000) return 'live';
  return 'ended';
}

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
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

/** PHP date('M j, Y · g:i A') in UTC. */
function humanWhen(d: Date): string {
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Where notification links point (the new web app). */
const webUrl = (path: string) =>
  `${(process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '')}${path}`;

export interface ScheduleInput {
  title: string;
  description: string | null;
  class_id: number | null;
  syllabus_id: number | null;
  subject_id: number | null;
  /** Wall-clock time as Eloquent stores it (see live-class.validation.ts). */
  scheduled_at: Date;
  duration_min: number;
  provider: 'jitsi' | 'external';
  meeting_url: string | null;
}

/** Port of App\Services\LiveClassService. */
@Injectable()
export class LiveClassService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationService,
  ) {}

  async find(id: bigint) {
    const lc = await this.db.query.live_classes.findFirst({
      where: eq(liveClassesTable.id, id),
    });
    if (!lc) throw modelNotFound('LiveClass', id);
    return lc;
  }

  /** Show endpoint: host and subject names loaded (`$live->load([...])`). */
  async withRelations(id: bigint) {
    const lc = await this.db.query.live_classes.findFirst({
      where: eq(liveClassesTable.id, id),
      with: {
        users: { columns: { name: true } },
        subjects: { columns: { name: true } },
      },
    });
    if (!lc) throw new Error(`No live_classes record for id ${id}`);
    return lc;
  }

  private async enrolledClassIds(student: users) {
    const rows = await this.db.query.class_student.findMany({
      where: eq(class_student.student_id, student.id),
      columns: { class_id: true },
      orderBy: [asc(class_student.id)],
    });
    return rows.map((r) => r.class_id);
  }

  /**
   * Classes a student can see: their enrolled classes, their syllabus, or their
   * school's school-wide classes. With none of those, the legacy query applied no
   * audience filter at all (every non-cancelled class); kept for parity.
   */
  async listForStudent(student: users) {
    const classIds = await this.enrolledClassIds(student);
    // not in legacy: Bodhira Direct counts as no school (common/direct-school.ts).
    const schoolId = await schoolOf(this.db, student);
    const t = liveClassesTable;
    const audience: (SQL | undefined)[] = [];
    if (classIds.length) audience.push(inArray(t.class_id, classIds));
    // security: not in legacy — a syllabus-scoped class only reaches students of
    // the host's own school.
    if (student.syllabus_id && schoolId)
      audience.push(
        and(eq(t.syllabus_id, student.syllabus_id), eq(t.school_id, schoolId)),
      );
    if (schoolId)
      audience.push(and(eq(t.school_id, schoolId), isNull(t.class_id)));

    // security: not in legacy — legacy applied no audience filter at all for a
    // student with no class, syllabus or school (every class of every school).
    if (!audience.length) return [];

    return this.db.query.live_classes.findMany({
      where: and(ne(t.status, 'cancelled'), or(...audience)),
      orderBy: [asc(t.scheduled_at), asc(t.id)],
      with: {
        users: { columns: { name: true } },
        subjects: { columns: { name: true } },
      },
    });
  }

  /** Student LiveClassApiController::canAccess. */
  async canAccess(student: users, lc: live_classes) {
    const classIds = await this.enrolledClassIds(student);
    const schoolId = await schoolOf(this.db, student); // Bodhira Direct: none
    return (
      (lc.class_id !== null && classIds.includes(lc.class_id)) ||
      // security: not in legacy — syllabus scope is limited to the host's school.
      (lc.syllabus_id !== null &&
        student.syllabus_id === lc.syllabus_id &&
        lc.school_id !== null &&
        schoolId === lc.school_id) ||
      (lc.school_id !== null &&
        schoolId === lc.school_id &&
        lc.class_id === null)
    );
  }

  async recordJoin(lc: live_classes, student: users) {
    const now = new Date();
    await this.db
      .insert(live_class_attendees)
      .values({
        live_class_id: lc.id,
        user_id: student.id,
        joined_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [
          live_class_attendees.live_class_id,
          live_class_attendees.user_id,
        ],
        set: { joined_at: now, updated_at: now },
      });
  }

  /** Names a teacher card needs (class, subject, syllabus, host) and the attendee count. */
  private static readonly HOST_VIEW = {
    classes: true,
    users: { columns: { name: true } },
    subjects: { columns: { name: true } },
    syllabi: { columns: { name: true, board: true, grade: true } },
  } as const;

  /** Not in legacy's API: relations and `attendees_count` for the teacher list/detail (legacy's web index showed them). */
  listForHost(teacher: users) {
    return this.db.query.live_classes.findMany({
      where: eq(liveClassesTable.host_id, teacher.id),
      orderBy: [desc(liveClassesTable.scheduled_at), asc(liveClassesTable.id)],
      with: LiveClassService.HOST_VIEW,
      extras: (t) => ({
        attendees_count: countOf(
          live_class_attendees,
          'live_class_id',
          t.id,
        ).as('attendees_count'),
      }),
    });
  }

  async hostView(id: bigint) {
    const lc = await this.db.query.live_classes.findFirst({
      where: eq(liveClassesTable.id, id),
      with: LiveClassService.HOST_VIEW,
      extras: (t) => ({
        attendees_count: countOf(
          live_class_attendees,
          'live_class_id',
          t.id,
        ).as('attendees_count'),
      }),
    });
    if (!lc) throw new Error(`No live_classes record for id ${id}`);
    return lc;
  }

  attendees(lc: live_classes) {
    return this.db.query.live_class_attendees.findMany({
      where: eq(live_class_attendees.live_class_id, lc.id),
      orderBy: [asc(live_class_attendees.id)],
      with: { users: { columns: { name: true } } },
    });
  }

  /**
   * security: not in legacy — a teacher may only target their own audience.
   * class: a class they teach (class teacher or linked subject teacher);
   * school: their own school; syllabus: a syllabus used by a class of their
   * school (a class that has a subject of that syllabus, or a student of the
   * school on it, or an opt-in); subject: the school's or a platform subject.
   */
  async assertCanSchedule(teacher: users, data: ScheduleInput) {
    if (data.class_id !== null) {
      const c = await this.db.query.classes.findFirst({
        where: eq(classesTable.id, BigInt(data.class_id)),
      });
      const teaches =
        !!c &&
        c.school_id === teacher.school_id &&
        (c.class_teacher_id === teacher.id ||
          !!(await this.db.query.class_subject.findFirst({
            where: and(
              eq(class_subject.class_id, c.id),
              eq(class_subject.teacher_id, teacher.id),
            ),
            columns: { id: true },
            orderBy: [asc(class_subject.id)],
          })));
      if (!teaches) throw new ApiException('You do not teach this class.', 403);
    } else if (data.syllabus_id !== null) {
      if (
        !teacher.school_id ||
        !(await this.schoolUsesSyllabus(
          teacher.school_id,
          BigInt(data.syllabus_id),
        ))
      ) {
        throw ValidationFailed.field(
          'syllabus_id',
          'The selected syllabus id is invalid.',
        );
      }
    } else if (!teacher.school_id) {
      throw ValidationFailed.field(
        'scope_type',
        'The selected scope type is invalid.',
      );
    }
    if (data.subject_id !== null) {
      const s = await this.db.query.subjects.findFirst({
        where: eq(subjectsTable.id, BigInt(data.subject_id)),
        columns: { school_id: true },
      });
      if (s && s.school_id !== null && s.school_id !== teacher.school_id) {
        throw ValidationFailed.field(
          'subject_id',
          'The selected subject id is invalid.',
        );
      }
    }
  }

  /**
   * The syllabi a school uses: its classes teach a subject of it, the school opted
   * into it, or one of its students is on it. One query (the schedule form used to
   * check every syllabus separately, up to three queries each).
   */
  async syllabiUsedBy(schoolId: bigint): Promise<Set<bigint>> {
    const rows = await this.db.execute<{ id: string }>(sql`
      select ${subjectsTable.syllabus_id} as id
        from ${classesTable}
        join ${class_subject} on ${class_subject.class_id} = ${classesTable.id}
        join ${subjectsTable} on ${subjectsTable.id} = ${class_subject.subject_id}
       where ${classesTable.school_id} = ${schoolId} and ${subjectsTable.syllabus_id} is not null
      union
      select ${schoolSyllabus.syllabus_id} from ${schoolSyllabus}
       where ${schoolSyllabus.school_id} = ${schoolId}
      union
      select ${usersTable.syllabus_id} from ${usersTable}
       where ${usersTable.school_id} = ${schoolId} and ${usersTable.role} = 'student'
         and ${usersTable.syllabus_id} is not null`);
    return new Set(rows.rows.map((r) => BigInt(r.id)));
  }

  async schoolUsesSyllabus(schoolId: bigint, syllabusId: bigint) {
    return (await this.syllabiUsedBy(schoolId)).has(syllabusId);
  }

  async schedule(teacher: users, data: ScheduleInput) {
    await this.assertCanSchedule(teacher, data);
    let room: string | null = null;
    let url = data.meeting_url;
    if (data.provider === 'jitsi' && !url) {
      const rand = Array.from(
        { length: 8 },
        () => LOWER_ALNUM[randomInt(LOWER_ALNUM.length)],
      ).join('');
      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      room = `bodhira-${rand}-${ymd}`;
      url = `${JITSI_HOST}/${room}`;
    }
    const now = new Date();
    const [lc] = await this.db
      .insert(liveClassesTable)
      .values({
        host_id: teacher.id,
        school_id: teacher.school_id,
        class_id: data.class_id === null ? null : BigInt(data.class_id),
        syllabus_id:
          data.syllabus_id === null ? null : BigInt(data.syllabus_id),
        subject_id: data.subject_id === null ? null : BigInt(data.subject_id),
        title: data.title,
        description: data.description,
        scheduled_at: data.scheduled_at,
        duration_min: data.duration_min,
        provider: data.provider,
        meeting_url: url,
        meeting_room: room,
        status: 'scheduled',
        created_at: now,
        updated_at: now,
      })
      .returning();
    await this.notifyAudience(lc, teacher);
    return lc;
  }

  async cancel(lc: live_classes) {
    const [row] = await this.db
      .update(liveClassesTable)
      .set({
        status: 'cancelled',
        updated_at: lc.status === 'cancelled' ? lc.updated_at : new Date(),
      })
      .where(eq(liveClassesTable.id, lc.id))
      .returning();
    if (!row) throw new Error(`No live_classes record for id ${lc.id}`);
    return row;
  }

  /** Teacher LiveClassApiController::notifyAudience → LiveClassScheduled (database channel). */
  private async notifyAudience(lc: live_classes, host: users) {
    let students: { id: bigint }[] = [];
    // not in legacy: Bodhira Direct has no school-wide audience.
    const schoolId = await schoolOf(this.db, lc);
    if (lc.class_id) {
      students = (
        await this.db.query.class_student.findMany({
          where: eq(class_student.class_id, lc.class_id),
          columns: { student_id: true },
          orderBy: [asc(class_student.id)],
        })
      ).map((r) => ({ id: r.student_id }));
    } else if (lc.syllabus_id) {
      students = await this.db.query.users.findMany({
        // security: not in legacy — students of the host's school only.
        where: and(
          eq(usersTable.syllabus_id, lc.syllabus_id),
          schoolId ? eq(usersTable.school_id, schoolId) : sql`false`,
          eq(usersTable.role, Role.Student),
        ),
        columns: { id: true },
        orderBy: [asc(usersTable.id)],
      });
    } else if (schoolId) {
      students = await this.db.query.users.findMany({
        where: and(
          eq(usersTable.school_id, schoolId),
          eq(usersTable.role, Role.Student),
        ),
        columns: { id: true },
        orderBy: [asc(usersTable.id)],
      });
    }

    await this.notifications.notifyMany(
      students.map((s) => s.id),
      'LiveClassScheduled',
      {
        type: 'live_class.scheduled',
        icon: '🎥',
        title: 'New live class',
        body: `${lc.title} on ${humanWhen(lc.scheduled_at)}`,
        meta: {
          live_class_id: Number(lc.id),
          scheduled_at: iso8601(lc.scheduled_at),
          host: host.name,
        },
        url: webUrl(`/student/live/${lc.id}`),
      },
    );
  }
}
