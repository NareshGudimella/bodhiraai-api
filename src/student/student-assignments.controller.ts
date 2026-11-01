import { SubscribedGuard } from './subscribed.guard';
import {
  Body,
  Controller,
  UseGuards,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import {
  forbidden,
  iso8601,
  modelNotFound,
  routeId,
} from '../common/http/laravel';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { myAsc } from '../db/helpers';
import {
  assignment_submissions as submissionsTable,
  assignments,
  class_student,
} from '../db/schema';
import type { assignment_submissions, users } from '../db/types';
import { NotificationService } from '../notification/notification.service';
import { StorageService } from '../storage/storage.service';
import type { IncomingFile } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFile,
} from '../storage/uploads';
import { classLabel } from '../teacher/teacher.service';

const webUrl = (path: string) =>
  `${(process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '')}${path}`;

const submissionJson = (s: assignment_submissions | undefined) =>
  s
    ? {
        id: s.id,
        status: s.status,
        note: s.note,
        file_url: s.file_url,
        score: s.score,
        feedback: s.feedback,
        submitted_at: iso8601(s.submitted_at),
        graded_at: iso8601(s.graded_at),
      }
    : null;

/**
 * New (not in the legacy API): student assignments, ported from the legacy
 * web StudentController (assignments / assignmentShow / assignmentSubmit).
 */
@Controller('student/assignments')
@Roles(Role.Student)
@UseGuards(SubscribedGuard) // security: not in legacy API
export class StudentAssignmentsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly notifications: NotificationService,
  ) {}

  private async classIds(student: users) {
    const rows = await this.db.query.class_student.findMany({
      where: eq(class_student.student_id, student.id),
      columns: { class_id: true },
      orderBy: [asc(class_student.id)],
    });
    return rows.map((r) => r.class_id);
  }

  /** Route binding, then `abort_unless(in my class && published, 403)`. */
  private async visible(student: users, raw: string) {
    const id = routeId(raw, 'Assignment');
    const a = await this.db.query.assignments.findFirst({
      where: eq(assignments.id, id),
      with: {
        subjects: { columns: { name: true } },
        classes: true,
        users: { columns: { name: true } },
      },
    });
    if (!a) throw modelNotFound('Assignment', id);
    if (!a.is_published || !(await this.classIds(student)).includes(a.class_id))
      throw forbidden();
    return a;
  }

  private status(a: { due_date: Date | null }, sub?: assignment_submissions) {
    return (
      sub?.status ??
      (a.due_date && a.due_date.getTime() < Date.now() ? 'missed' : 'pending')
    );
  }

  @Get()
  async index(@CurrentUser() user: users) {
    const rows = await this.db.query.assignments.findMany({
      where: and(
        inArray(assignments.class_id, await this.classIds(user)),
        eq(assignments.is_published, true),
      ),
      orderBy: [myAsc(assignments.due_date), asc(assignments.id)],
      with: { subjects: { columns: { name: true } }, classes: true },
    });
    const subs = new Map(
      (
        await this.db.query.assignment_submissions.findMany({
          where: and(
            eq(submissionsTable.student_id, user.id),
            inArray(
              submissionsTable.assignment_id,
              rows.map((a) => a.id),
            ),
          ),
          orderBy: [asc(submissionsTable.id)],
        })
      ).map((s) => [s.assignment_id, s]),
    );
    return ok(
      rows.map((a) => ({
        id: a.id,
        title: a.title,
        subject: a.subjects?.name ?? null,
        class: classLabel(a.classes),
        due_date: iso8601(a.due_date),
        max_marks: a.max_marks,
        status: this.status(a, subs.get(a.id)),
        submission: submissionJson(subs.get(a.id)),
      })),
    );
  }

  @Get(':assignment')
  async show(@CurrentUser() user: users, @Param('assignment') raw: string) {
    const a = await this.visible(user, raw);
    const sub = await this.db.query.assignment_submissions.findFirst({
      where: and(
        eq(submissionsTable.assignment_id, a.id),
        eq(submissionsTable.student_id, user.id),
      ),
    });
    return ok({
      assignment: {
        id: a.id,
        title: a.title,
        description: a.description,
        attachment_url: a.attachment_url,
        subject: a.subjects?.name ?? null,
        class: classLabel(a.classes),
        teacher: a.users?.name ?? null,
        due_date: iso8601(a.due_date),
        max_marks: a.max_marks,
      },
      status: this.status(a, sub ?? undefined),
      submission: submissionJson(sub ?? undefined),
    });
  }

  /** Multipart: `note` (≤2000 chars) and/or `file` (doc types, ≤50 MB). Resubmitting updates the same row. */
  @Post(':assignment/submit')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', uploadOptions(55)))
  async submit(
    @CurrentUser() user: users,
    @Param('assignment') raw: string,
    @Body() body: unknown,
    @UploadedFile() file?: IncomingFile,
  ) {
    const a = await this.visible(user, raw);
    const data = await validateWithFile(
      this.db,
      body,
      { note: ['nullable', 'string', 'max:2000'] },
      file,
      {
        field: 'file',
        kind: 'file',
        maxKb: 51200,
      },
    );
    const fileUrl = file
      ? await storeOrReject('file', () =>
          this.storage.store(file, 'doc', `submissions/${a.id}`),
        )
      : undefined;

    const now = new Date();
    const payload = {
      note: (data.note as string | null | undefined) ?? null,
      status: 'submitted',
      submitted_at: now,
      updated_at: now,
      ...(fileUrl && { file_url: fileUrl }),
    };
    const [sub] = await this.db
      .insert(submissionsTable)
      .values({
        assignment_id: a.id,
        student_id: user.id,
        created_at: now,
        ...payload,
      })
      .onConflictDoUpdate({
        target: [submissionsTable.assignment_id, submissionsTable.student_id],
        set: payload,
      })
      .returning();

    await this.notifications.notifyMany([a.teacher_id], 'NewSubmission', {
      type: 'submission.received',
      icon: '📥',
      title: 'New submission',
      body: `${user.name} submitted '${a.title}'`,
      meta: {
        submission_id: Number(sub.id),
        assignment_id: Number(a.id),
        student_id: Number(user.id),
      },
      // Legacy linked to its grading page; the new web grades on the assignment page.
      url: webUrl(`/teacher/assignments/${a.id}`),
    });
    return ok(submissionJson(sub), 'Submission saved.');
  }
}
