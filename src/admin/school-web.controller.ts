import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { toModel, withPivot } from '../common/http/eloquent';
import {
  forbidden,
  modelNotFound,
  modelNotFoundClass,
  routeId,
} from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc } from '../db/helpers';
import {
  parent_student,
  school_syllabus,
  schools,
  subjects as subjectsTable,
  syllabi as syllabiTable,
  users as usersTable,
} from '../db/schema';
import type { users } from '../db/types';
import { eqOrNull } from './admin.service';

const USER_MODEL = 'App\\Models\\User';

/**
 * New endpoints for features the legacy school admin had only as web routes:
 * parent ↔ student links (Web\AdminController::linkChild/unlinkChild, the
 * userEdit page) and syllabus opt-in (Web\SchoolSyllabusController).
 */
@Controller('admin')
@Roles(Role.Admin)
export class SchoolWebController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Route-model binding plus AdminController::guard (bare 403 for another school). */
  private async user(admin: users, raw: string) {
    const id = routeId(raw, 'User');
    const u = await this.db.query.users.findFirst({
      where: eq(usersTable.id, id),
    });
    if (!u) throw modelNotFound('User', id);
    if (u.school_id !== admin.school_id) throw forbidden();
    return u;
  }

  /** The userEdit page: current links (with pivot) and who can still be linked. */
  @Get('users/:user/links')
  async links(@CurrentUser() admin: users, @Param('user') raw: string) {
    const user = await this.user(admin, raw);
    const isParent = (user.role as Role) === Role.Parent;
    if (!isParent && (user.role as Role) !== Role.Student) {
      return ok({ links: [], linkable: [] });
    }
    const pivots = await this.db.query.parent_student.findMany({
      where: isParent
        ? eq(parent_student.parent_id, user.id)
        : eq(parent_student.student_id, user.id),
      orderBy: [asc(parent_student.id)],
    });
    const otherIds = pivots.map((p) => (isParent ? p.student_id : p.parent_id));
    const others = await this.db.query.users.findMany({
      where: inArray(usersTable.id, otherIds),
      orderBy: [asc(usersTable.id)],
    });
    const byId = new Map(others.map((o) => [o.id, o]));
    const links = pivots.flatMap((p) => {
      const o = byId.get(isParent ? p.student_id : p.parent_id);
      return o
        ? [
            withPivot('users', o, p, {
              foreign: isParent ? 'parent_id' : 'student_id',
              related: isParent ? 'student_id' : 'parent_id',
              columns: ['relation'],
            }),
          ]
        : [];
    });
    const linkable = await this.db
      .select(
        isParent
          ? {
              id: usersTable.id,
              name: usersTable.name,
              grade: usersTable.grade,
            }
          : {
              id: usersTable.id,
              name: usersTable.name,
              phone: usersTable.phone,
            },
      )
      .from(usersTable)
      .where(
        and(
          eqOrNull(usersTable.school_id, user.school_id),
          eq(usersTable.role, isParent ? Role.Student : Role.Parent),
          notInArray(usersTable.id, otherIds),
        ),
      )
      .orderBy(asc(usersTable.name), asc(usersTable.id));
    return ok({ links, linkable });
  }

  /** linkChild: the user is the parent (pick a student) or the student (pick a parent). */
  @Post('users/:user/links')
  @HttpCode(200)
  async link(
    @CurrentUser() admin: users,
    @Param('user') raw: string,
    @Body() body: unknown,
  ) {
    const user = await this.user(admin, raw);
    const data = await laravelValidate(this.db, body, {
      student_id: ['required_without:parent_id', 'nullable', 'exists:users,id'],
      parent_id: ['required_without:student_id', 'nullable', 'exists:users,id'],
      relation: ['nullable', 'string', 'max:20'],
    });
    const key =
      (user.role as Role) === Role.Parent ? 'student_id' : 'parent_id';
    // Legacy reads $data[key] directly; when only the other id was sent it
    // hits an undefined array key, which Laravel turns into a 500.
    if (!(key in data)) {
      throw new ApiException('Server error', 500);
    }
    const otherId = BigInt(Math.trunc(Number(data[key] ?? 0)));
    const [parentId, studentId] =
      key === 'student_id' ? [user.id, otherId] : [otherId, user.id];
    await this.linkParentChild(
      admin,
      parentId,
      studentId,
      (data.relation as string | null | undefined) ?? null,
    );
    return ok(null, 'Link added.');
  }

  /** AdminService::linkParentChild: both must be in the admin's school, with the right roles. */
  private async linkParentChild(
    admin: users,
    parentId: bigint,
    studentId: bigint,
    relation: string | null,
  ) {
    const find = (id: bigint, role: Role) =>
      this.db.query.users.findFirst({
        where: and(
          eq(usersTable.id, id),
          eqOrNull(usersTable.school_id, admin.school_id),
          eq(usersTable.role, role),
        ),
        orderBy: [asc(usersTable.id)],
      });
    const parent = await find(parentId, Role.Parent);
    if (!parent) throw modelNotFoundClass(USER_MODEL);
    const student = await find(studentId, Role.Student);
    if (!student) throw modelNotFoundClass(USER_MODEL);

    // syncWithoutDetaching([id => ['relation' => …]]): insert, or update the
    // pivot's relation (and updated_at) only when it changed.
    const existing = await this.db.query.parent_student.findFirst({
      where: and(
        eq(parent_student.parent_id, parent.id),
        eq(parent_student.student_id, student.id),
      ),
      orderBy: [asc(parent_student.id)],
    });
    const now = new Date();
    if (!existing) {
      await this.db.insert(parent_student).values({
        parent_id: parent.id,
        student_id: student.id,
        relation,
        created_at: now,
        updated_at: now,
      });
    } else if (existing.relation !== relation) {
      await this.db
        .update(parent_student)
        .set({ relation, updated_at: now })
        .where(eq(parent_student.id, existing.id));
    }
  }

  @Delete('users/:user/links/:other')
  async unlink(
    @CurrentUser() admin: users,
    @Param('user') raw: string,
    @Param('other') otherRaw: string,
  ) {
    const user = await this.user(admin, raw);
    const otherId = routeId(otherRaw, 'User');
    const other = await this.db.query.users.findFirst({
      where: eq(usersTable.id, otherId),
    });
    if (!other) throw modelNotFound('User', otherId);
    const [parentId, studentId] =
      (user.role as Role) === Role.Parent
        ? [user.id, other.id]
        : [other.id, user.id];
    // AdminService::unlinkParentChild: the parent must be in the admin's school (any role).
    const parent = await this.db.query.users.findFirst({
      where: and(
        eq(usersTable.id, parentId),
        eqOrNull(usersTable.school_id, admin.school_id),
      ),
      orderBy: [asc(usersTable.id)],
    });
    if (!parent) throw modelNotFoundClass(USER_MODEL);
    await this.db
      .delete(parent_student)
      .where(
        and(
          eq(parent_student.parent_id, parent.id),
          eq(parent_student.student_id, studentId),
        ),
      );
    return ok(null, 'Link removed.');
  }

  /** SchoolSyllabusController::index: active syllabi and the ones the school opted into. */
  @Get('syllabi')
  async syllabi(@CurrentUser() admin: users) {
    const school = admin.school_id
      ? await this.db.query.schools.findFirst({
          where: and(
            eq(schools.id, admin.school_id),
            isNull(schools.deleted_at),
          ),
          orderBy: [asc(schools.id)],
        })
      : null;
    if (!school) throw new ApiException('You are not linked to a school.', 403);
    const [opted, syllabi] = await Promise.all([
      this.db
        .select({ syllabus_id: school_syllabus.syllabus_id })
        .from(school_syllabus)
        .where(eq(school_syllabus.school_id, school.id))
        .orderBy(asc(school_syllabus.id)),
      this.db.query.syllabi.findMany({
        where: eq(syllabiTable.is_active, true),
        orderBy: [
          asc(syllabiTable.sort_order),
          asc(syllabiTable.board),
          asc(syllabiTable.grade),
          asc(syllabiTable.id),
        ],
      }),
    ]);
    // Not in legacy API: the per-syllabus count the Blade view computes with
    // `$s->subjects()->whereNull('school_id')->count()` (platform subjects only).
    const counts = await this.db
      .select({
        syllabus_id: subjectsTable.syllabus_id,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(subjectsTable)
      .where(isNull(subjectsTable.school_id))
      .groupBy(subjectsTable.syllabus_id);
    const countOfSyllabus = new Map(
      counts.map((c) => [String(c.syllabus_id), c.n]),
    );
    return ok({
      school: { id: school.id, name: school.name },
      syllabi: syllabi.map((s) => ({
        ...toModel('syllabi', s),
        subjects_count: countOfSyllabus.get(String(s.id)) ?? 0,
      })),
      opted_ids: opted.map((o) => o.syllabus_id),
    });
  }

  /** SchoolSyllabusController::toggle: subscribe or unsubscribe (any syllabus, active or not). */
  @Post('syllabi/:syllabus/toggle')
  @HttpCode(200)
  async toggleSyllabus(
    @CurrentUser() admin: users,
    @Param('syllabus') raw: string,
  ) {
    const id = routeId(raw, 'Syllabus');
    const syllabus = await this.db.query.syllabi.findFirst({
      where: eq(syllabiTable.id, id),
    });
    if (!syllabus) throw modelNotFound('Syllabus', id);
    const school = admin.school_id
      ? await this.db.query.schools.findFirst({
          where: and(
            eq(schools.id, admin.school_id),
            isNull(schools.deleted_at),
          ),
          orderBy: [asc(schools.id)],
        })
      : null;
    if (!school) throw forbidden();

    const where = and(
      eq(school_syllabus.school_id, school.id),
      eq(school_syllabus.syllabus_id, syllabus.id),
    );
    if (await this.db.query.school_syllabus.findFirst({ where })) {
      await this.db.delete(school_syllabus).where(where);
      return ok(
        { subscribed: false },
        `Unsubscribed from ${syllabus.name}. Its subjects are no longer visible to your students.`,
      );
    }
    const now = new Date();
    await this.db.insert(school_syllabus).values({
      school_id: school.id,
      syllabus_id: syllabus.id,
      created_at: now,
      updated_at: now,
    });
    return ok(
      { subscribed: true },
      `Subscribed to ${syllabus.name}. Its subjects now appear in your content library.`,
    );
  }
}
