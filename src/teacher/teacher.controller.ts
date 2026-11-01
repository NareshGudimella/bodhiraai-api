import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { ValidationFailed } from '../common/http/api.exception';
import { iso8601, parseLaravelDate, routeId } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import type { users } from '../db/types';
import { ForgedFileUrl, unsignFileUrl } from '../storage/file-url';
import { StorageService } from '../storage/storage.service';
import type { IncomingFile } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFile,
} from '../storage/uploads';
import { classLabel, TeacherService } from './teacher.service';

/** Date-only value from a validated/parsed date (Carbon::parse(...)->toDateString()). */
const dayOf = (value: string) => {
  const parsed = parseLaravelDate(value);
  return parsed
    ? new Date(`${parsed.stored.toISOString().slice(0, 10)}T00:00:00Z`)
    : null;
};

/** /api/v1/teacher/* — port of Api\V1\Teacher\TeacherController (live classes live in LiveClassModule). */
@Controller('teacher')
@Roles(Role.Teacher)
export class TeacherController {
  constructor(
    private readonly teachers: TeacherService,
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  @Get('home')
  async home(@CurrentUser() user: users) {
    return ok(await this.teachers.dashboard(user));
  }

  @Get('classes')
  async classes(@CurrentUser() user: users) {
    const rows = await this.teachers.classesTaught(user);
    const names = await this.teachers.classTeacherNames(rows);
    return ok(
      rows.map((c) => ({
        id: c.id,
        label: classLabel(c),
        grade: c.grade,
        section: c.section,
        students_count: c.students_count,
        academic_year: c.academic_year,
        // Not in legacy's API: the class teacher's name (the class card shows it).
        class_teacher:
          (c.class_teacher_id && names.get(c.class_teacher_id)) || null,
      })),
    );
  }

  @Get('classes/:class')
  async classShow(@CurrentUser() user: users, @Param('class') raw: string) {
    const c = await this.teachers.findClass(routeId(raw, 'Klass'));
    await this.teachers.guardClass(user, c);
    return ok(await this.teachers.classDetail(c));
  }

  @Get('classes/:class/attendance')
  async attendance(
    @CurrentUser() user: users,
    @Param('class') raw: string,
    @Query('date') date?: string,
  ) {
    const c = await this.teachers.findClass(routeId(raw, 'Klass'));
    await this.teachers.guardClass(user, c);
    const day =
      (date && dayOf(date)) ||
      new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    return ok(await this.teachers.attendanceFor(c, day));
  }

  @Post('classes/:class/attendance')
  @HttpCode(200)
  async saveAttendance(
    @CurrentUser() user: users,
    @Param('class') raw: string,
    @Body() body: unknown,
  ) {
    const c = await this.teachers.findClass(routeId(raw, 'Klass'));
    await this.teachers.guardClass(user, c);
    const data = await laravelValidate(this.db, body, {
      date: ['required', 'date'],
      records: ['required', 'array'],
      'records.*': ['required', 'in:present,absent,late,excused'],
    });
    const saved = await this.teachers.saveAttendance(
      c,
      user,
      dayOf(data.date as string)!,
      data.records as Record<string, string>,
    );
    return ok({ saved }, 'Attendance saved.');
  }

  @Get('assignments')
  async assignments(@CurrentUser() user: users) {
    const rows = await this.teachers.assignmentsByTeacher(user);
    return ok(
      rows.map((a) => ({
        id: a.id,
        title: a.title,
        class: a.classes ? classLabel(a.classes) : null,
        subject: a.subjects?.name ?? null,
        due_date: iso8601(a.due_date),
        max_marks: a.max_marks,
        submissions_count: a.submissions_count,
        is_published: a.is_published,
      })),
    );
  }

  /**
   * Legacy validates first, then loads the class and checks the teacher teaches it.
   * Multipart `attachment` (any doc type, ≤50 MB) is not in legacy's API; it is the
   * legacy web form's upload (`assignmentStore`), stored under `assignments/<class id>`.
   * `attachment_url` still works; an uploaded file wins over it, as in the web form.
   */
  @Post('assignments')
  @UseInterceptors(FileInterceptor('attachment', uploadOptions(55)))
  async createAssignment(
    @CurrentUser() user: users,
    @Body() body: unknown,
    @UploadedFile() attachment?: IncomingFile,
  ) {
    const data = await validateWithFile(
      this.db,
      body,
      {
        class_id: ['required', 'exists:classes,id'],
        subject_id: ['nullable', 'exists:subjects,id'],
        title: ['required', 'string', 'max:160'],
        description: ['nullable', 'string'],
        attachment_url: ['nullable', 'url'],
        due_date: ['nullable', 'date'],
        max_marks: ['required', 'integer', 'min:1', 'max:1000'],
      },
      attachment,
      { field: 'attachment', kind: 'file', maxKb: 51200 },
    );
    const c = await this.teachers.findClass(
      BigInt(data.class_id as string | number),
    );
    await this.teachers.guardClass(user, c);
    if (attachment) {
      data.attachment_url = await storeOrReject('attachment', () =>
        // security: not in legacy: private, served by signed link
        this.storage.store(attachment, 'doc', `assignments/${c.id}`, {
          private: true,
        }),
      );
    } else if ('attachment_url' in data) {
      // security: not in legacy: our own signed link sent back is stored as
      // `/files/<key>`; a forged one fails like Laravel's `url` rule.
      try {
        data.attachment_url = unsignFileUrl(data.attachment_url);
      } catch (e) {
        if (!(e instanceof ForgedFileUrl)) throw e;
        throw ValidationFailed.field(
          'attachment_url',
          'The attachment url field must be a valid URL.',
        );
      }
    }
    const due =
      typeof data.due_date === 'string'
        ? parseLaravelDate(data.due_date)!.stored
        : null;
    const a = await this.teachers.createAssignment(user, data, due);
    return ok({ id: a.id }, 'Assignment created.');
  }

  @Get('assignments/:assignment')
  async assignmentDetail(
    @CurrentUser() user: users,
    @Param('assignment') raw: string,
  ) {
    const a = await this.teachers.ownAssignment(
      user,
      routeId(raw, 'Assignment'),
    );
    return ok(await this.teachers.assignmentDetail(a));
  }

  @Post('submissions/:submission/grade')
  @HttpCode(200)
  async grade(
    @CurrentUser() user: users,
    @Param('submission') raw: string,
    @Body() body: unknown,
  ) {
    const sub = await this.teachers.ownSubmission(
      user,
      routeId(raw, 'AssignmentSubmission'),
    );
    const data = await laravelValidate(this.db, body, {
      score: ['required', 'integer', 'min:0'],
      feedback: ['nullable', 'string'],
    });
    const graded = await this.teachers.gradeSubmission(
      sub,
      user,
      Number(data.score),
      (data.feedback as string | null | undefined) ?? null,
    );
    return ok(
      {
        id: graded.id,
        score: graded.score,
        status: graded.status,
        graded_at: iso8601(graded.graded_at),
      },
      'Submission graded.',
    );
  }

  @Get('quizzes')
  async quizzes(@CurrentUser() user: users) {
    const rows = await this.teachers.quizzesByTeacher(user);
    return ok(
      rows.map((q) => ({
        id: q.id,
        title: q.title,
        subject: q.subjects?.name ?? null,
        chapter: q.chapters?.title ?? null,
        duration_min: q.duration_min,
        total_marks: q.total_marks,
        questions_count: q.questions_count,
        attempts_count: q.attempts_count,
        is_published: q.is_published,
      })),
    );
  }

  @Get('quizzes/:quiz/analytics')
  async quizAnalytics(@CurrentUser() user: users, @Param('quiz') raw: string) {
    const q = await this.teachers.ownQuiz(user, routeId(raw, 'Quiz'));
    return ok(await this.teachers.quizAnalytics(q));
  }
}
