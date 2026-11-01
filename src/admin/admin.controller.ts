import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, eq, notInArray } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { modelNotFound, routeId } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { pageFrom, pageMeta } from '../common/http/paginate';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc } from '../db/helpers';
import {
  class_student,
  class_subject,
  classes,
  subjects,
  users as usersTable,
} from '../db/schema';
import type { users } from '../db/types';
import { classLabel } from '../teacher/teacher.service';
import {
  AdminService,
  EDITABLE_ROLES,
  eqOrNull,
  guardSameSchool,
} from './admin.service';
import { signedFileUrl } from '../storage/file-url';

const ROLES = Object.values(Role).join(',');

/** AdminApiController::validateUser (with `->ignore($user->id)` on update). */
const userRules = (ignore?: bigint, lockedRole?: string) => {
  const u = ignore ? `,${ignore}` : '';
  return {
    name: ['required', 'string', 'max:120'],
    email: ['nullable', 'email', 'max:160', `unique:users,email${u}`],
    phone: ['nullable', 'string', 'max:20', `unique:users,phone${u}`],
    username: [
      'nullable',
      'string',
      'max:40',
      'regex:/^[a-zA-Z0-9._\\-]+$/',
      `unique:users,username${u}`,
    ],
    // Not in legacy: an admin account being edited may only keep its own role.
    role: ['required', `in:${lockedRole ?? 'student,teacher,parent'}`],
    gender: ['nullable', 'string', 'max:10'],
    grade: ['nullable', 'string', 'max:10'],
    dob: ['nullable', 'date'],
    password: [ignore ? 'nullable' : 'required', 'string', 'min:6'],
  };
};

const SUBJECT_RULES = {
  name: ['required', 'string', 'max:120'],
  grade: ['nullable', 'string', 'max:10'],
  icon: ['nullable', 'string', 'max:8'],
  color: ['nullable', 'string', 'max:20'],
  description: ['nullable', 'string'],
};

/** /api/v1/admin/* — port of Api\V1\Admin\AdminApiController (admins and super admins). */
@Controller('admin')
@Roles(Role.Admin, Role.SuperAdmin)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    @Inject(DB) private readonly db: Db,
  ) {}

  private async findUser(raw: string) {
    const id = routeId(raw, 'User');
    const u = await this.db.query.users.findFirst({
      where: eq(usersTable.id, id),
    });
    if (!u) throw modelNotFound('User', id);
    return u;
  }

  private async findClass(raw: string) {
    const id = routeId(raw, 'Klass');
    const c = await this.db.query.classes.findFirst({
      where: eq(classes.id, id),
      columns: { id: true, school_id: true },
    });
    if (!c) throw modelNotFound('Klass', id);
    return c;
  }

  private async findSubject(raw: string) {
    const id = routeId(raw, 'Subject');
    const s = await this.db.query.subjects.findFirst({
      where: eq(subjects.id, id),
      columns: { id: true, school_id: true },
    });
    if (!s) throw modelNotFound('Subject', id);
    return s;
  }

  @Get('home')
  async home(@CurrentUser() user: users) {
    return ok(await this.admin.dashboard(user));
  }

  @Get('users')
  async users(
    @CurrentUser() user: users,
    @Query() query: Record<string, unknown>,
  ) {
    const data = await laravelValidate(this.db, query, {
      role: ['nullable', `in:${ROLES}`],
      q: ['nullable', 'string', 'max:120'],
      per_page: ['nullable', 'integer', 'min:1', 'max:100'],
    });
    const perPage = data.per_page ? Number(data.per_page) : 20;
    const page = pageFrom(query.page);
    const { items, total } = await this.admin.paginatedUsers(
      user,
      (data.role as string | null) ?? null,
      (data.q as string | null) ?? null,
      perPage,
      page,
    );
    return ok(
      items.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        grade: u.grade,
        status: u.status,
        // not in legacy API: the Blade list shows avatars (signed: security: not in legacy)
        avatar: signedFileUrl(u.avatar),
      })),
      null,
      pageMeta(page, perPage, total),
    );
  }

  @Post('users')
  async createUser(@CurrentUser() user: users, @Body() body: unknown) {
    const data = await laravelValidate(this.db, body, userRules());
    await this.admin.enforceSeatCap(user, data.role as string);
    const created = await this.admin.createUser(user, data);
    return ok({ id: created.id }, 'User created.');
  }

  /** New (not in the legacy API): seat usage panel of the legacy web create-user page. */
  @Get('users/seats')
  async seats(@CurrentUser() user: users) {
    return ok(await this.admin.seatInfo(user));
  }

  /** New (not in the legacy API): one user for the web edit form (legacy userEdit page). */
  @Get('users/:user')
  async user(@CurrentUser() user: users, @Param('user') raw: string) {
    const u = await this.findUser(raw);
    guardSameSchool(user, u);
    return ok({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      username: u.username,
      role: u.role,
      gender: u.gender,
      grade: u.grade,
      dob: u.dob ? u.dob.toISOString().slice(0, 10) : null,
      status: u.status,
    });
  }

  @Patch('users/:user')
  async updateUser(
    @CurrentUser() user: users,
    @Param('user') raw: string,
    @Body() body: unknown,
  ) {
    const target = await this.findUser(raw);
    const data = await laravelValidate(
      this.db,
      body,
      userRules(
        target.id,
        EDITABLE_ROLES.includes(target.role as Role) ? undefined : target.role,
      ),
    );
    const u = await this.admin.updateUser(user, target, data);
    return ok({ id: u.id }, 'User updated.');
  }

  @Post('users/:user/toggle')
  @HttpCode(200)
  async toggleUser(@CurrentUser() user: users, @Param('user') raw: string) {
    const u = await this.admin.toggleUser(user, await this.findUser(raw));
    return ok({ status: u.status }, 'User status toggled.');
  }

  @Get('classes')
  async classes(@CurrentUser() user: users) {
    const rows = await this.admin.classes(user);
    return ok(
      rows.map((c) => ({
        id: c.id,
        label: classLabel(c),
        grade: c.grade,
        section: c.section,
        academic_year: c.academic_year,
        class_teacher: c.users?.name ?? null,
        students_count: c.students_count,
        subjects_count: c.subjects_count,
      })),
    );
  }

  @Post('classes')
  async createClass(@CurrentUser() user: users, @Body() body: unknown) {
    const data = await laravelValidate(this.db, body, {
      grade: ['required', 'string', 'max:10'],
      section: ['required', 'string', 'max:10'],
      academic_year: ['nullable', 'string', 'max:9'],
      class_teacher_id: ['nullable', 'exists:users,id'],
    });
    const c = await this.admin.createClass(user, data);
    return ok({ id: c.id }, 'Class created.');
  }

  @Get('classes/:class')
  async classShow(@CurrentUser() user: users, @Param('class') raw: string) {
    const c = await this.findClass(raw);
    return ok(await this.admin.classDetail(user, c.id));
  }

  /**
   * New (not in the legacy API): what can be added to a class, from the legacy
   * web AdminService::classDetail (available_students / available_subjects / teachers).
   */
  @Get('classes/:class/options')
  async classOptions(@CurrentUser() user: users, @Param('class') raw: string) {
    const c = await this.findClass(raw);
    guardSameSchool(user, c);
    const [enrolled, linked] = await Promise.all([
      this.db
        .select({ student_id: class_student.student_id })
        .from(class_student)
        .where(eq(class_student.class_id, c.id))
        .orderBy(asc(class_student.id)),
      this.db
        .select({ subject_id: class_subject.subject_id })
        .from(class_subject)
        .where(eq(class_subject.class_id, c.id))
        .orderBy(asc(class_subject.id)),
    ]);
    const [students, subjectRows, teachers] = await Promise.all([
      this.db
        .select({
          id: usersTable.id,
          name: usersTable.name,
          grade: usersTable.grade,
        })
        .from(usersTable)
        .where(
          and(
            eqOrNull(usersTable.school_id, user.school_id),
            eq(usersTable.role, Role.Student),
            notInArray(
              usersTable.id,
              enrolled.map((e) => e.student_id),
            ),
          ),
        )
        .orderBy(asc(usersTable.name), asc(usersTable.id)),
      this.db
        .select({
          id: subjects.id,
          name: subjects.name,
          grade: subjects.grade,
        })
        .from(subjects)
        .where(
          and(
            eqOrNull(subjects.school_id, user.school_id),
            notInArray(
              subjects.id,
              linked.map((l) => l.subject_id),
            ),
          ),
        )
        .orderBy(asc(subjects.name), asc(subjects.id)),
      this.db
        .select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable)
        .where(
          and(
            eqOrNull(usersTable.school_id, user.school_id),
            eq(usersTable.role, Role.Teacher),
          ),
        )
        .orderBy(asc(usersTable.name), asc(usersTable.id)),
    ]);
    return ok({
      available_students: students,
      available_subjects: subjectRows,
      teachers,
    });
  }

  @Post('classes/:class/students')
  @HttpCode(200)
  async enrol(
    @CurrentUser() user: users,
    @Param('class') raw: string,
    @Body() body: unknown,
  ) {
    const c = await this.findClass(raw);
    const data = await laravelValidate(this.db, body, {
      student_id: ['required', 'exists:users,id'],
      roll_no: ['nullable', 'string', 'max:20'],
    });
    await this.admin.enrol(
      user,
      c,
      BigInt(data.student_id as string | number),
      (data.roll_no as string | null) ?? null,
    );
    return ok(null, 'Student enrolled.');
  }

  @Delete('classes/:class/students/:student')
  async unenrol(
    @CurrentUser() user: users,
    @Param('class') raw: string,
    @Param('student') studentRaw: string,
  ) {
    const c = await this.findClass(raw);
    const student = await this.findUser(studentRaw);
    await this.admin.unenrol(user, c, student.id);
    return ok(null, 'Student removed.');
  }

  @Post('classes/:class/subjects')
  @HttpCode(200)
  async linkSubject(
    @CurrentUser() user: users,
    @Param('class') raw: string,
    @Body() body: unknown,
  ) {
    const c = await this.findClass(raw);
    const data = await laravelValidate(this.db, body, {
      subject_id: ['required', 'exists:subjects,id'],
      teacher_id: ['nullable', 'exists:users,id'],
    });
    await this.admin.linkSubject(
      user,
      c,
      BigInt(data.subject_id as string | number),
      data.teacher_id == null
        ? null
        : BigInt(data.teacher_id as string | number),
    );
    return ok(null, 'Subject linked.');
  }

  @Delete('classes/:class/subjects/:subject')
  async unlinkSubject(
    @CurrentUser() user: users,
    @Param('class') raw: string,
    @Param('subject') subjectRaw: string,
  ) {
    const c = await this.findClass(raw);
    const s = await this.findSubject(subjectRaw);
    await this.admin.unlinkSubject(user, c, s.id);
    return ok(null, 'Subject unlinked.');
  }

  @Get('subjects')
  async subjects(@CurrentUser() user: users) {
    const rows = await this.admin.subjects(user);
    return ok(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        grade: s.grade,
        icon: s.icon,
        color: s.color,
        is_active: s.is_active,
        description: s.description, // not in legacy API: the web edit form needs it
        chapters_count: s.chapters_count,
      })),
    );
  }

  @Post('subjects')
  async createSubject(@CurrentUser() user: users, @Body() body: unknown) {
    const data = await laravelValidate(this.db, body, SUBJECT_RULES);
    const s = await this.admin.createSubject(user, data);
    return ok({ id: s.id }, 'Subject created.');
  }

  @Patch('subjects/:subject')
  async updateSubject(
    @CurrentUser() user: users,
    @Param('subject') raw: string,
    @Body() body: unknown,
  ) {
    const subject = await this.findSubject(raw);
    const data = await laravelValidate(this.db, body, {
      ...SUBJECT_RULES,
      is_active: ['nullable', 'boolean'],
    });
    const s = await this.admin.updateSubject(user, subject, data);
    return ok({ id: s.id }, 'Subject updated.');
  }

  @Delete('subjects/:subject')
  async deleteSubject(
    @CurrentUser() user: users,
    @Param('subject') raw: string,
  ) {
    const subject = await this.findSubject(raw);
    guardSameSchool(user, subject);
    await this.admin.deleteSubject(user, subject);
    return ok(null, 'Subject deleted.');
  }

  @Get('analytics')
  async analytics(@CurrentUser() user: users) {
    return ok(await this.admin.analytics(user));
  }
}
