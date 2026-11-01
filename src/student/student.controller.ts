import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { eloquentRow, iso8601, routeId } from '../common/http/laravel';
import { Role } from '../common/roles';
import { validateBody } from '../common/http/validation';
import { DB, type Db } from '../db/db';
import { schools } from '../db/schema';
import type { users } from '../db/types';
import { badgeCollection } from './badge-catalog';
import { AnswerDto, ProgressDto } from './student.dto';
import {
  chapterResource,
  lessonResource,
  quizResource,
  subjectResource,
} from './student.resources';
import { StudentReportService } from './student-report.service';
import { StudentService } from './student.service';
import { SubscribedGuard } from './subscribed.guard';
import { SubscriptionAccessService } from './subscription-access.service';
import { schoolOf } from '../common/direct-school';

const USER_JSON = {
  hidden: ['password', 'remember_token', 'otp', 'otp_expires_at'],
  casts: {
    email_verified_at: 'datetime',
    phone_verified_at: 'datetime',
    last_login_at: 'datetime',
    dob: 'date',
    avatar: 'file', // security: not in legacy (signed private-file link)
  },
} as const;

const SCHOOL_JSON = {
  casts: {
    logo: 'file', // security: not in legacy (signed private-file link)
    plan_expires_at: 'date',
    settings: 'array',
    max_teachers: 'int',
    max_students: 'int',
    ai_daily_token_limit: 'int',
  },
} as const;

/** /api/v1/student/* — ports of Api\V1\Student\{StudentHome,Subject,Lesson,Quiz}Controller. */
@Controller('student')
@Roles(Role.Student)
export class StudentController {
  constructor(
    private readonly service: StudentService,
    private readonly access: SubscriptionAccessService,
    private readonly report: StudentReportService,
    @Inject(DB) private readonly db: Db,
  ) {}

  // ── Home & profile ──

  @UseGuards(SubscribedGuard) // security: not in legacy API (legacy web gated home)
  @Get('home')
  async home(@CurrentUser() user: users) {
    const { chapterCounts, ...data } = await this.service.dashboard(user);
    return ok({
      ...data,
      // chapters_count is not in the legacy API (the legacy web view read it).
      subjects: data.subjects.map((s) =>
        subjectResource(s, chapterCounts.get(s.id)),
      ),
    });
  }

  @Get('profile')
  @UseGuards(SubscribedGuard) // security: not in legacy API (legacy web gated it)
  async profile(@CurrentUser() user: users) {
    const summary = await this.service.profileSummary(user);
    // not in legacy: Bodhira Direct shows as no school (common/direct-school.ts).
    const schoolId = await schoolOf(this.db, user);
    const school = schoolId
      ? await this.db.query.schools.findFirst({
          where: eq(schools.id, schoolId),
        })
      : null;
    return ok({
      student: {
        ...eloquentRow(user, USER_JSON),
        school: school ? eloquentRow(school, SCHOOL_JSON) : null,
      },
      ...summary,
      // not in legacy API: the legacy web profile's quiz reports, attendance,
      // AI usage, badge count and board (StudentController::profileExtras).
      ...(await this.report.profileExtras(user, summary.xp)),
      achievements: summary.achievements.map((a) =>
        eloquentRow(a, { casts: { meta: 'array', earned_at: 'datetime' } }),
      ),
    });
  }

  /**
   * Port of StudentController::profileReport (web route student.profile.report):
   * the student's PDF progress report, always an attachment.
   */
  @Get('profile/report')
  @UseGuards(SubscribedGuard) // security: not in legacy API (legacy web gated it)
  async profileReport(@CurrentUser() user: users, @Res() res: Response) {
    const { pdf, header } = await this.report.render(user);
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': header,
      })
      .send(pdf);
  }

  @Get('badges')
  @UseGuards(SubscribedGuard) // security: not in legacy API (legacy web gated it)
  async badges(@CurrentUser() user: users) {
    const c = badgeCollection(await this.service.earnedBadges(user));
    return ok({
      badges: c.badges.map((b) => ({
        key: b.key,
        title: b.title,
        icon: b.icon,
        tier: b.tier,
        tier_label: b.tierMeta.label,
        colors: b.tierMeta.stops,
        glow: b.tierMeta.glow,
        xp: b.xp,
        desc: b.desc,
        earned: b.earned,
        earned_at: iso8601(b.earned_at),
      })),
      earned_count: c.earned_count,
      total: c.total,
      total_xp: c.total_xp,
      completion_percent: c.completion_percent,
    });
  }

  /**
   * New (not in the legacy API): whether the student passes the `subscribed`
   * gate. The web uses it to redirect to /paywall like the legacy web did.
   */
  @Get('access')
  async accessStatus(@CurrentUser() user: users) {
    return ok({ has_access: await this.access.hasAccess(user) });
  }

  // ── Subjects, chapters, lessons ──

  @Get('subjects')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  async subjects(@CurrentUser() user: users) {
    const rows = await this.service.subjectsWithChapterCounts(user);
    const completion = await this.service.lessonCompletion(
      user,
      'subject',
      rows.map((r) => r.subject.id),
    );
    return ok(
      rows.map((r) => ({
        ...subjectResource(r.subject, r.chaptersCount),
        completion: completion.get(r.subject.id), // not in legacy
      })),
    );
  }

  @Get('subjects/:subject')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  async subject(@CurrentUser() user: users, @Param('subject') raw: string) {
    const subject = await this.service.findSubject(routeId(raw, 'Subject'));
    await this.service.authorizeSubject(user, subject);
    const chapters = await this.service.chaptersFor(subject.id);
    const completion = await this.service.lessonCompletion(
      user,
      'chapter',
      chapters.map((c) => c.id),
    );
    return ok({
      subject: subjectResource(subject),
      chapters: chapters.map((c) => ({
        ...chapterResource(c, c.lessons_count),
        completion: completion.get(c.id), // not in legacy
      })),
    });
  }

  @Get('chapters/:chapter/lessons')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  async chapterLessons(
    @CurrentUser() user: users,
    @Param('chapter') raw: string,
  ) {
    const chapter = await this.service.findChapter(
      user,
      routeId(raw, 'Chapter'),
    );
    const lessons = await this.service.lessonsFor(chapter.id);
    return ok({
      chapter: {
        id: chapter.id,
        title: chapter.title,
        subject_id: chapter.subject_id,
      },
      lessons: lessons.map((l) => lessonResource(l)),
      // New, additive: completion + chapter-quiz unlock state (legacy web-only data).
      quiz_state: await this.service.chapterQuizState(
        user,
        chapter.id,
        lessons.map((l) => l.id),
      ),
    });
  }

  @Get('lessons/:lesson')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  async lesson(@CurrentUser() user: users, @Param('lesson') raw: string) {
    const detail = await this.service.lessonDetail(
      user,
      routeId(raw, 'Lesson'),
    );
    return ok({
      lesson: lessonResource(detail.lesson, { withBody: true }),
      progress: detail.progress,
      siblings: detail.siblings,
    });
  }

  @Post('lessons/:lesson/progress')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  @HttpCode(200)
  async progress(
    @CurrentUser() user: users,
    @Param('lesson') raw: string,
    @Body() body: unknown,
  ) {
    // Laravel order: route binding (404) before validation (422).
    const lesson = await this.service.findLesson(user, routeId(raw, 'Lesson'));
    const dto = await validateBody(ProgressDto, body);
    const p = await this.service.recordProgress(
      user,
      lesson,
      dto.watched_seconds,
      dto.completed,
    );
    return ok(
      {
        status: p.status,
        watched_seconds: p.watched_seconds,
        progress_percent: p.progress_percent,
      },
      'Progress saved.',
    );
  }

  // ── Quizzes ──

  @Get('quizzes')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  async quizzes(@CurrentUser() user: users) {
    return ok(await this.service.upcomingQuizzes(user, 20));
  }

  @Get('quizzes/:quiz')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  async quiz(@CurrentUser() user: users, @Param('quiz') raw: string) {
    return ok(
      quizResource(await this.service.findQuiz(user, routeId(raw, 'Quiz'))),
    );
  }

  @Post('quizzes/:quiz/start')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  @HttpCode(200)
  async start(@CurrentUser() user: users, @Param('quiz') raw: string) {
    const quiz = await this.service.findQuiz(user, routeId(raw, 'Quiz'));
    const attempt = await this.service.startAttempt(user, quiz);
    return ok(
      {
        attempt: {
          id: attempt.id,
          status: attempt.status,
          started_at: iso8601(attempt.started_at),
        },
        quiz: quizResource({ ...quiz, chapters: undefined }),
      },
      'Attempt started.',
    );
  }

  @Post('attempts/:attempt/answer')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  @HttpCode(200)
  async answer(
    @CurrentUser() user: users,
    @Param('attempt') raw: string,
    @Body() body: unknown,
  ) {
    // Laravel order: binding and guardAttempt (404/403/422) before validation.
    const attempt = await this.service.openAttempt(
      user,
      routeId(raw, 'QuizAttempt'),
    );
    const dto = await validateBody(AnswerDto, body);
    return ok(
      await this.service.recordAnswer(attempt, dto.question_id, dto.answer),
      'Answer recorded.',
    );
  }

  @Post('attempts/:attempt/submit')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  @HttpCode(200)
  async submit(@CurrentUser() user: users, @Param('attempt') raw: string) {
    const attempt = await this.service.openAttempt(
      user,
      routeId(raw, 'QuizAttempt'),
    );
    const result = await this.service.submitAttempt(attempt);
    return ok(
      {
        attempt_id: result.id,
        score: result.score,
        total_marks: result.total_marks,
        percent:
          result.total_marks > 0
            ? Math.round((result.score / result.total_marks) * 100)
            : 0,
        submitted_at: iso8601(result.submitted_at),
        // New, additive: badge awarding moved here from the legacy web controller.
        celebration: await this.service.awardQuizBadges(user, result),
      },
      'Quiz submitted.',
    );
  }

  /** New: result screen data (legacy web-only route /student/attempts/{id}/result). */
  @Get('attempts/:attempt')
  @UseGuards(SubscribedGuard) // security: not in legacy API
  async attempt(@CurrentUser() user: users, @Param('attempt') raw: string) {
    const a = await this.service.attemptResult(
      user,
      routeId(raw, 'QuizAttempt'),
    );
    const quiz = a.quizzes;
    const reveal = a.status !== 'in_progress';
    return ok({
      id: a.id,
      status: a.status,
      score: a.score,
      total_marks: a.total_marks,
      percent:
        a.total_marks > 0 ? Math.round((a.score / a.total_marks) * 100) : 0,
      passed: a.score >= quiz.pass_marks,
      started_at: iso8601(a.started_at),
      submitted_at: iso8601(a.submitted_at),
      quiz: quizResource({ ...quiz, questions: undefined }),
      // security: not in legacy — the answer key (and per-answer correctness)
      // is only revealed once the attempt is submitted.
      answers: a.quiz_answers
        .sort((x, y) => x.questions.sort_order - y.questions.sort_order)
        .map((ans) => ({
          question_id: ans.question_id,
          body: ans.questions.body,
          type: ans.questions.type,
          marks: ans.questions.marks,
          options: JSON.parse(ans.questions.options ?? 'null') as unknown,
          answer: JSON.parse(ans.answer ?? 'null') as unknown,
          correct_answer: reveal
            ? (JSON.parse(ans.questions.correct_answer ?? 'null') as unknown)
            : null,
          explanation: reveal ? ans.questions.explanation : null,
          is_correct: reveal ? ans.is_correct : null,
          marks_awarded: reveal ? ans.marks_awarded : null,
        })),
    });
  }
}
