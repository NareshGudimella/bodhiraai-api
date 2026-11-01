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
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  assertPhoneFree,
  dobValue,
  PROFILE_RULES,
} from '../account/account.controller';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { routeId } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import type { classes, users } from '../db/types';
import { StorageService } from '../storage/storage.service';
import type { IncomingFile } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFile,
} from '../storage/uploads';
import { RosterService, type StudentInput } from './roster.service';
import { classLabel, TeacherService } from './teacher.service';

const studentRules = (ignoreId?: bigint) => ({
  ...PROFILE_RULES,
  roll_no: ['nullable', 'string', 'max:30'],
  email: [
    'nullable',
    'email',
    'max:255',
    `unique:users,email${ignoreId ? `,${ignoreId}` : ''}`,
  ],
  password: ['nullable', 'string', 'min:6'],
});

const AVATAR = { field: 'avatar', kind: 'image' as const, maxKb: 4096 };

const rosterRow = (s: users, rollNo: string | null) => ({
  id: s.id,
  name: s.name,
  username: s.username,
  email: s.email,
  phone: s.phone,
  gender: s.gender,
  dob: s.dob ? s.dob.toISOString().slice(0, 10) : null,
  avatar: s.avatar,
  status: s.status,
  roll_no: rollNo,
});

/**
 * New (not in the legacy API): class roster management and the student
 * profile, ported from the legacy web TeacherController.
 */
@Controller('teacher')
@Roles(Role.Teacher)
export class RosterController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly teachers: TeacherService,
    private readonly roster: RosterService,
    private readonly storage: StorageService,
  ) {}

  private async input(
    data: Record<string, unknown>,
    avatar?: IncomingFile,
  ): Promise<StudentInput> {
    const s = (k: string) => (typeof data[k] === 'string' ? data[k] : null);
    return {
      name: s('name')!,
      email: s('email'),
      phone: s('phone'),
      gender: s('gender'),
      dob: dobValue(data.dob),
      password: s('password'),
      roll_no: s('roll_no'),
      avatarUrl: avatar
        ? await storeOrReject('avatar', () =>
            this.storage.storeCloud(avatar, 'image'),
          )
        : undefined,
    };
  }

  private async classAndStudent(
    teacher: users,
    classRaw: string,
    studentRaw: string,
  ) {
    const c: classes = await this.teachers.findClass(
      routeId(classRaw, 'Klass'),
    );
    const student = await this.roster.findStudent(routeId(studentRaw, 'User'));
    const enrolment = await this.roster.enrolment(teacher, c, student);
    return { c, student, enrolment };
  }

  @Post('classes/:class/students')
  @UseInterceptors(FileInterceptor('avatar', uploadOptions(12)))
  async add(
    @CurrentUser() user: users,
    @Param('class') raw: string,
    @Body() body: unknown,
    @UploadedFile() avatar?: IncomingFile,
  ) {
    const c = await this.teachers.findClass(routeId(raw, 'Klass'));
    await this.teachers.guardClass(user, c);
    const data = await validateWithFile(
      this.db,
      body,
      studentRules(),
      avatar,
      AVATAR,
    );
    await assertPhoneFree(this.db, data.phone);
    const student = await this.roster.addStudent(
      user,
      c,
      await this.input(data, avatar),
    );
    return ok(
      rosterRow(student, (data.roll_no as string | null) ?? null),
      `✓ ${student.name} added to ${classLabel(c)}.`,
    );
  }

  @Put('classes/:class/students/:student')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('avatar', uploadOptions(12)))
  async update(
    @CurrentUser() user: users,
    @Param('class') classRaw: string,
    @Param('student') studentRaw: string,
    @Body() body: unknown,
    @UploadedFile() avatar?: IncomingFile,
  ) {
    const { c, student } = await this.classAndStudent(
      user,
      classRaw,
      studentRaw,
    );
    const data = await validateWithFile(
      this.db,
      body,
      studentRules(student.id),
      avatar,
      AVATAR,
    );
    await assertPhoneFree(this.db, data.phone, student.id);
    const updated = await this.roster.updateStudent(
      c,
      student,
      await this.input(data, avatar),
    );
    return ok(
      rosterRow(updated, (data.roll_no as string | null) ?? null),
      `✓ ${updated.name}'s profile updated.`,
    );
  }

  @Patch('classes/:class/students/:student/status')
  async status(
    @CurrentUser() user: users,
    @Param('class') classRaw: string,
    @Param('student') studentRaw: string,
    @Body() body: unknown,
  ) {
    const { student, enrolment } = await this.classAndStudent(
      user,
      classRaw,
      studentRaw,
    );
    const data = await laravelValidate(this.db, body, {
      status: ['required', 'in:active,on_hold,blocked'],
    });
    const updated = await this.roster.setStatus(student, data.status as string);
    const label = {
      active: 'activated',
      on_hold: 'put on hold',
      blocked: 'blocked',
    }[data.status as string];
    return ok(
      rosterRow(updated, enrolment.roll_no),
      `✓ ${updated.name} has been ${label}.`,
    );
  }

  @Delete('classes/:class/students/:student')
  async remove(
    @CurrentUser() user: users,
    @Param('class') classRaw: string,
    @Param('student') studentRaw: string,
  ) {
    const { student } = await this.classAndStudent(user, classRaw, studentRaw);
    await this.roster.remove(student);
    return ok(null, `🗑 ${student.name} has been deleted.`);
  }

  @Get('students/:student')
  async profile(@CurrentUser() user: users, @Param('student') raw: string) {
    const student = await this.roster.findStudent(routeId(raw, 'User'));
    await this.roster.guardTeaches(user, student);
    return ok(await this.roster.profile(student));
  }
}
