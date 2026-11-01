import { Controller, Get, Inject, Logger, Param } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import { CurrentUser } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit';
import { ok } from '../common/http/api-response';
import { ApiException } from '../common/http/api.exception';
import { modelNotFound, routeId } from '../common/http/laravel';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { class_subject, classes, lessons } from '../db/schema';
import type { lessons as Lesson, subjects, users } from '../db/types';
import { signedFileUrl } from '../storage/file-url';
import { StudentService } from '../student/student.service';
import { SUBSCRIPTION_INACTIVE_MESSAGE } from '../student/subscribed.guard';
import { SubscriptionAccessService } from '../student/subscription-access.service';
import { VdoCipherClient } from './vdocipher.client';
import { AdminContentService } from '../admin/admin-content.service';

const CANT_PLAY = "You can't play this lesson.";

/**
 * security: not in legacy. `GET /api/v1/lessons/:id/playback` (contract:
 * protected media, 2026-11-01): how to play a lesson's video, for the people
 * allowed to watch it.
 *
 *  - Students who may open the lesson (GET /student/lessons/:id rules: the
 *    subscription paywall first (402), then published content of a subject
 *    they can see).
 *  - Teachers who teach the lesson's subject to a class in their school (class
 *    teacher of a class with the subject, or the class_subject teacher); a
 *    subject owned by another school never qualifies.
 *  - not in legacy (2026-11-01): school admins, for published lessons of a
 *    subject in a curriculum their school uses or of their school's own
 *    (AdminContentService.mayWatch); watermarked with their name and email.
 *  - Everyone else (super admins, parents, …): 403.
 *
 * 404 when the lesson doesn't exist or has no video. VdoCipher videos get an
 * OTP watermarked with the viewer's name and phone/email; other videos a
 * (signed) URL. 60 requests a minute per user.
 */
@Controller('lessons')
export class LessonPlaybackController {
  private readonly logger = new Logger(LessonPlaybackController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly students: StudentService,
    private readonly access: SubscriptionAccessService,
    private readonly vdo: VdoCipherClient,
    private readonly adminContent: AdminContentService,
  ) {}

  @Get(':lesson/playback')
  @RateLimit(60, 'user')
  async playback(@CurrentUser() user: users, @Param('lesson') raw: string) {
    const id = routeId(raw, 'Lesson');
    const isStudent = user.role === (Role.Student as string);
    // Same order as the student routes: the paywall guard runs before lookup.
    if (isStudent && !(await this.access.hasAccess(user)))
      throw new ApiException(
        SUBSCRIPTION_INACTIVE_MESSAGE,
        402,
        'subscription_inactive',
      );

    const lesson = await this.db.query.lessons.findFirst({
      where: eq(lessons.id, id),
      with: { chapters: { with: { subjects: true } } },
    });
    if (!lesson) throw modelNotFound('Lesson', id);

    const subject = lesson.chapters?.subjects ?? null;
    const allowed = isStudent
      ? await this.studentMayOpen(user, lesson, subject)
      : user.role === (Role.Teacher as string)
        ? await this.teacherTeaches(user, subject)
        : user.role === (Role.Admin as string)
          ? await this.adminMayWatch(user, lesson, subject)
          : false;
    if (!allowed) throw new ApiException(CANT_PLAY, 403);

    if (lesson.video_id) {
      if (!this.vdo.configured())
        throw new ApiException('Video playback is not available.', 503);
      // An admin's watermark is their name and email (not in legacy, 2026-11-01).
      const contact =
        user.role === (Role.Admin as string)
          ? user.email || user.phone || ''
          : user.phone || user.email || '';
      const watermark = contact ? `${user.name} · ${contact}` : user.name;
      try {
        const { otp, playbackInfo, ttl } = await this.vdo.otp(
          lesson.video_id,
          watermark,
        );
        return ok(
          {
            provider: 'vdocipher',
            otp,
            playback_info: playbackInfo,
            expires_in: ttl,
          },
          '',
        );
      } catch (e) {
        this.logger.warn(`OTP for lesson ${id} failed: ${String(e)}`);
        throw new ApiException('Video playback is not available.', 502);
      }
    }
    if (lesson.type === 'video' && lesson.content_url)
      return ok(
        { provider: 'url', url: signedFileUrl(lesson.content_url) },
        '',
      );
    throw new ApiException('This lesson has no video.', 404);
  }

  /** GET /student/lessons/:id rules (StudentService.lessonDetail). */
  private async studentMayOpen(
    student: users,
    lesson: Lesson & { chapters: { is_published: boolean } },
    subject: subjects | null,
  ) {
    if (!lesson.is_published || !lesson.chapters.is_published || !subject)
      return false;
    try {
      await this.students.authorizeSubject(student, subject);
      return true;
    } catch (e) {
      if (e instanceof ApiException) return false;
      throw e;
    }
  }

  private async adminMayWatch(
    admin: users,
    lesson: Lesson & { chapters: { is_published: boolean } },
    subject: subjects | null,
  ) {
    if (!lesson.is_published || !lesson.chapters.is_published || !subject)
      return false;
    return this.adminContent.mayWatch(admin, subject);
  }

  private async teacherTeaches(teacher: users, subject: subjects | null) {
    if (!teacher.school_id || !subject) return false;
    // Another school's own subject never counts, even if linked to a class here.
    if (subject.school_id && subject.school_id !== teacher.school_id)
      return false;
    const subjectId = subject.id;
    const [row] = await this.db
      .select({ x: sql`1` })
      .from(class_subject)
      .innerJoin(classes, eq(classes.id, class_subject.class_id))
      .where(
        and(
          eq(class_subject.subject_id, subjectId),
          eq(classes.school_id, teacher.school_id),
          or(
            eq(classes.class_teacher_id, teacher.id),
            eq(class_subject.teacher_id, teacher.id),
          ),
        ),
      )
      .limit(1);
    return !!row;
  }
}
