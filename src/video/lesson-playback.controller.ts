import { Controller, Get, HttpException, Inject, Param } from '@nestjs/common';
import { and, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { CurrentUser } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit';
import { ok } from '../common/http/api-response';
import { ApiException } from '../common/http/api.exception';
import { modelNotFound, routeId } from '../common/http/laravel';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import {
  class_subject,
  classes,
  lesson_progress,
  lessons,
  video_sessions,
} from '../db/schema';
import type { lessons as Lesson, subjects, users } from '../db/types';
import { signedFileUrl } from '../storage/file-url';
import { StudentService } from '../student/student.service';
import { SUBSCRIPTION_INACTIVE_MESSAGE } from '../student/subscribed.guard';
import { SubscriptionAccessService } from '../student/subscription-access.service';
import { filesBaseUrl } from '../storage/file-url';
import { signHlsToken } from './hls-token';
import {
  istStamp,
  KEY_WINDOW_MS,
  newSessionId,
  overPlaybackLimit,
  segmentsUntil,
} from './video-session';
import { AdminContentService } from '../admin/admin-content.service';

/** not in legacy: 409 with the code under both `code` (envelope) and `error` (contract); clients read either. */
function videoState(message: string, code: string) {
  const e = new ApiException(message, 409, code);
  const body = e.getResponse() as object;
  return new HttpException({ ...body, error: code }, 409);
}

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
 * 404 when the lesson doesn't exist or has no video; 409 `video_processing`
 * while an upload is being transcoded and `video_failed` when that gave up
 * (not in legacy). Self-hosted videos get an encrypted-HLS master URL with a
 * playback token (docs/video-hls-contract.md; the files are served by
 * hls.controller.ts) and the viewer's email as watermark; other videos a
 * (signed) URL. 60 requests a minute per user.
 */
@Controller('lessons')
export class LessonPlaybackController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly students: StudentService,
    private readonly access: SubscriptionAccessService,
    private readonly adminContent: AdminContentService,
  ) {}

  @Get(':lesson/playback')
  @RateLimit(60, 'user')
  async playback(
    @CurrentUser() user: users,
    @Param('lesson') raw: string,
    @Client() client: ClientInfo,
  ) {
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

    // not in legacy: an upload the worker is still transcoding, or gave up on.
    if (lesson.video_status === 'processing')
      throw videoState(
        'This video is still processing. Please try again in a few minutes.',
        'video_processing',
      );
    if (lesson.video_status === 'failed')
      throw videoState(
        'This video could not be processed. Please upload it again.',
        'video_failed',
      );
    if (lesson.video_hls_path) {
      // not in legacy: strict playback protection (contract, last section).
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 3600_000);
      const dayAgo = new Date(now.getTime() - 24 * 3600_000);
      const mine = eq(video_sessions.user_id, user.id);
      const session = newSessionId();
      const until = segmentsUntil(now, lesson.duration_sec);
      // Count, revoke and insert under a per-user lock, so parallel requests can't
      // slip past the limit (pg_advisory_xact_lock: transaction-scoped, pooler-safe).
      const limited = await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${'video-session:' + String(user.id)}, 0))`,
        );
        const [{ h, d }] = await tx
          .select({
            h: sql<number>`count(*) filter (where ${gte(video_sessions.created_at, hourAgo)})`.mapWith(
              Number,
            ),
            d: sql<number>`count(*)`.mapWith(Number),
          })
          .from(video_sessions)
          .where(and(mine, gte(video_sessions.created_at, dayAgo)));
        if (overPlaybackLimit(h, d)) return true;
        // One active stream per account.
        await tx
          .update(video_sessions)
          .set({ revoked_at: now })
          .where(and(mine, isNull(video_sessions.revoked_at)));
        await tx.insert(video_sessions).values({
          id: session,
          user_id: user.id,
          lesson_id: lesson.id,
          ip: client.ip,
          user_agent: client.userAgent.slice(0, 500),
          created_at: now,
          key_deadline: new Date(now.getTime() + KEY_WINDOW_MS),
          segments_until: until,
        });
        return false;
      });
      if (limited) {
        const e = new ApiException(
          'Too many plays in a short time. Try again later.',
          429,
          'playback_limit',
        );
        throw new HttpException(
          { ...(e.getResponse() as object), error: 'playback_limit' },
          429,
        );
      }
      // Not a Bearer URL: native players can't send headers, so the token rides in `t`.
      const exp = Math.floor(until.getTime() / 1000);
      const token = signHlsToken(session, lesson.id, user.id, exp);
      // not in legacy: every successful play counts as a view (replays too).
      if (isStudent) await this.countView(user.id, lesson.id);
      return ok(
        {
          type: 'hls',
          url: `${filesBaseUrl()}/api/v1/lessons/${lesson.id}/hls/master.m3u8?t=${token}`,
          watermark: `${user.email || user.phone || user.name} · ID ${user.id} · ${istStamp(now)}`,
          expires_at: until.toISOString(),
          session,
        },
        '',
      );
    }
    if (lesson.type === 'video' && lesson.content_url) {
      // not in legacy: every successful play counts as a view (replays too).
      if (isStudent) await this.countView(user.id, lesson.id);
      return ok({ type: 'url', url: signedFileUrl(lesson.content_url) }, '');
    }
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

  /** One more view for this student and lesson (creates the progress row on a first play). */
  private async countView(studentId: bigint, lessonId: bigint) {
    const now = new Date();
    await this.db
      .insert(lesson_progress)
      .values({
        student_id: studentId,
        lesson_id: lessonId,
        view_count: 1,
        last_viewed_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [lesson_progress.student_id, lesson_progress.lesson_id],
        set: {
          view_count: sql`${lesson_progress.view_count} + 1`,
          last_viewed_at: now,
          updated_at: now,
        },
      });
  }
}
