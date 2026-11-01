import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { ApiException } from '../common/http/api.exception';
import {
  dateString,
  diffForHumans,
  jsonCast,
  modelNotFound,
  phpJsonEncode,
  phpRound,
} from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { asc, countOf, desc, myDesc, mySum } from '../db/helpers';
import {
  achievements,
  assignment_submissions,
  assignments,
  chapters,
  class_student,
  lesson_progress,
  lessons as lessonsTable,
  questions,
  quiz_answers,
  quiz_attempts as quizAttemptsTable,
  quizzes as quizzesTable,
  school_syllabus,
  schools,
  subjects as subjectsTable,
} from '../db/schema';
import type {
  lessons,
  quiz_attempts,
  quizzes,
  subjects,
  users,
} from '../db/types';
import { getBadge, tierRank, type Badge } from './badge-catalog';
import { schoolOf } from '../common/direct-school';
import { signedFileUrl } from '../storage/file-url';

/** Port of App\Services\StudentService. Keep logic identical; note deviations inline. */
@Injectable()
export class StudentService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async dashboard(student: users) {
    // Bodhira Direct shows as no school, like a legacy B2C student.
    const schoolId = await schoolOf(this.db, student);
    const school = schoolId
      ? await this.db.query.schools.findFirst({
          where: eq(schools.id, schoolId),
        })
      : null;
    const withCounts = await this.subjectsWithChapterCounts(student);
    const subjects = withCounts.map((r) => r.subject);
    const totalLessons = await this.totalLessons(subjects);
    const completed = await this.completedLessons(student);
    const xp = await this.computeXp(student);

    return {
      student: {
        id: student.id,
        name: student.name,
        grade: student.grade,
        avatar: signedFileUrl(student.avatar), // security: not in legacy: signed private-file link
        school: school?.name ?? null,
      },
      stats: {
        streak_days: await this.computeStreak(student),
        subjects_count: subjects.length,
        xp,
        lessons_completed: completed,
        lessons_total: totalLessons,
        completion_percent:
          totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0,
        // not in legacy: lessons finished today (UTC day), for the mobile "today" ring
        lessons_today: await this.lessonsCompletedToday(student),
        // not in legacy: 70 XP per level, as the legacy dashboard view computes it
        ...levelInfo(xp),
      },
      continue_learning: await this.continueLearning(student, 30),
      subjects,
      // The controller adds `chapters_count` to each subject from this (not in legacy API).
      chapterCounts: new Map(
        withCounts.map((r) => [r.subject.id, r.chaptersCount]),
      ),
      upcoming_quizzes: await this.upcomingQuizzes(student, 3, subjects),
      // not in legacy API: the legacy web home's `performance` and profile completion
      performance: await this.performanceStats(student),
      profile_completion_percent: this.profileCompletion(student, school?.name),
    };
  }

  /** Home view: share of name, avatar, grade, school, email and phone that are filled in. */
  private profileCompletion(student: users, schoolName?: string | null) {
    const filled = [
      student.name,
      student.avatar,
      student.grade,
      schoolName,
      student.email,
      student.phone,
    ].filter((v) => !!v && v !== '0').length;
    return Math.round((filled / 6) * 100);
  }

  private async lessonsCompletedToday(student: users) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    return this.db.$count(
      lesson_progress,
      and(
        eq(lesson_progress.student_id, student.id),
        eq(lesson_progress.status, 'completed'),
        gte(lesson_progress.completed_at, start),
        lt(
          lesson_progress.completed_at,
          new Date(start.getTime() + 86_400_000),
        ),
      ),
    );
  }

  /** Port of StudentService::performanceStats (without the weekly sparkline). */
  async performanceStats(student: users) {
    const attempts = await this.db.query.quiz_attempts.findMany({
      where: and(
        eq(quizAttemptsTable.student_id, student.id),
        eq(quizAttemptsTable.status, 'submitted'),
      ),
      orderBy: [asc(quizAttemptsTable.id)],
      with: { quizzes: { with: { subjects: true } } },
    });
    const pct = (a: quiz_attempts) =>
      a.total_marks > 0 ? (a.score / a.total_marks) * 100 : 0;
    const avg = (xs: quiz_attempts[]) =>
      xs.reduce((n, a) => n + pct(a), 0) / xs.length;

    const classIds = (
      await this.db.query.class_student.findMany({
        where: eq(class_student.student_id, student.id),
        columns: { class_id: true },
        orderBy: [asc(class_student.id)],
      })
    ).map((r) => r.class_id);
    const assignTotal = classIds.length
      ? await this.db.$count(
          assignments,
          and(
            inArray(assignments.class_id, classIds),
            eq(assignments.is_published, true),
          ),
        )
      : 0;
    const assignDone = await this.db.$count(
      assignment_submissions,
      and(
        eq(assignment_submissions.student_id, student.id),
        eq(assignment_submissions.status, 'submitted'),
      ),
    );

    const groups = new Map<string, typeof attempts>();
    for (const a of attempts) {
      const sid = a.quizzes?.subject_id;
      if (!sid) continue;
      groups.set(String(sid), [...(groups.get(String(sid)) ?? []), a]);
    }
    const subjectScores = [...groups.values()]
      .map((grp) => {
        const subject = grp[0].quizzes?.subjects;
        return {
          name: subject?.name ?? 'Subject',
          color: subject?.color || '#C49560',
          icon: subject?.icon || '📘',
          percent: phpRound(avg(grp)),
        };
      })
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 6);

    return {
      overall_score: attempts.length ? phpRound(avg(attempts)) : 0,
      quizzes_taken: attempts.length,
      assignments_done: assignDone,
      assignments_total: assignTotal,
      tests_passed: attempts.filter(
        (a) => a.quizzes && a.score >= a.quizzes.pass_marks,
      ).length,
      tests_total: attempts.length,
      subject_scores: subjectScores,
    };
  }

  /**
   * Visibility rules: the student's school's subjects, OR subjects of the student's
   * syllabus, OR subjects of syllabi the school opted into; filtered by grade.
   * A Bodhira Direct student is treated as having no school (common/direct-school.ts).
   */
  private async syllabusIdsFor(student: users) {
    const syllabusIds = new Set<bigint>();
    const schoolId = await schoolOf(this.db, student);
    if (schoolId) {
      const opted = await this.db.query.school_syllabus.findMany({
        where: eq(school_syllabus.school_id, schoolId),
        columns: { syllabus_id: true },
        orderBy: [asc(school_syllabus.id)],
      });
      opted.forEach((o) => syllabusIds.add(o.syllabus_id));
    }
    if (student.syllabus_id) syllabusIds.add(student.syllabus_id);
    return syllabusIds;
  }

  async subjectsForStudent(student: users): Promise<subjects[]> {
    const syllabusIds = await this.syllabusIdsFor(student);
    const schoolId = await schoolOf(this.db, student);

    const visible: SQL[] = [];
    if (schoolId) visible.push(eq(subjectsTable.school_id, schoolId));
    if (syllabusIds.size)
      visible.push(inArray(subjectsTable.syllabus_id, [...syllabusIds]));
    // No school AND no syllabus: show nothing rather than the whole table.
    if (!visible.length) return [];

    return this.db.query.subjects.findMany({
      where: and(
        eq(subjectsTable.is_active, true),
        or(...visible),
        student.grade
          ? or(
              eq(subjectsTable.grade, student.grade),
              isNull(subjectsTable.grade),
            )
          : undefined,
      ),
      orderBy: [
        asc(subjectsTable.sort_order),
        asc(subjectsTable.name),
        asc(subjectsTable.id),
      ],
    });
  }

  async findSubject(id: bigint) {
    const subject = await this.db.query.subjects.findFirst({
      where: eq(subjectsTable.id, id),
    });
    if (!subject) throw modelNotFound('Subject', id);
    return subject;
  }

  /**
   * SubjectController::authorizeSubject, plus (security: not in legacy) the
   * same visibility the subject list applies: a school-owned subject needs the
   * same school (a school-less student no longer passes), and a platform
   * subject of a syllabus needs the student's own or an opted-in syllabus.
   */
  async authorizeSubject(student: users, subject: subjects) {
    const schoolId = await schoolOf(this.db, student);
    if (subject.school_id && schoolId && subject.school_id !== schoolId) {
      throw new ApiException('Subject not available for your school.', 403);
    }
    if (subject.grade && student.grade && subject.grade !== student.grade) {
      throw new ApiException('Subject not for your grade.', 403);
    }
    // security: not in legacy — the subject must be one the student's subject list
    // shows (subjectsForStudent): their school's own, or on a syllabus they follow.
    // Legacy let a student without a school open any school's subject by id.
    const ownSchool = !!schoolId && subject.school_id === schoolId;
    const onSyllabus =
      !!subject.syllabus_id &&
      (await this.syllabusIdsFor(student)).has(subject.syllabus_id);
    if (!ownSchool && !onSyllabus) {
      throw new ApiException('Subject not available for your school.', 403);
    }
    // security: not in legacy — a deactivated subject is hidden from the list too.
    if (!subject.is_active) {
      throw modelNotFound('Subject', subject.id);
    }
  }

  /**
   * security: not in legacy — chapter/lesson/quiz routes were open to any
   * student by id. Same rule as the subject routes, via the content's subject,
   * and only published content (else 404, like a missing record).
   */
  private async authorizeSubjectId(student: users, subjectId: bigint) {
    const subject = await this.db.query.subjects.findFirst({
      where: eq(subjectsTable.id, subjectId),
    });
    if (!subject) throw modelNotFound('Subject', subjectId);
    await this.authorizeSubject(student, subject);
  }

  async subjectsWithChapterCounts(student: users) {
    const subjects = await this.subjectsForStudent(student);
    const counts = await this.db
      .select({ subject_id: chapters.subject_id, n: count() })
      .from(chapters)
      .where(
        and(
          inArray(
            chapters.subject_id,
            subjects.map((s) => s.id),
          ),
          eq(chapters.is_published, true),
        ),
      )
      .groupBy(chapters.subject_id);
    const bySubject = new Map(counts.map((c) => [c.subject_id, c.n]));
    return subjects.map((s) => ({
      subject: s,
      chaptersCount: bySubject.get(s.id) ?? 0,
    }));
  }

  /**
   * Not in legacy (added for the mobile app's progress rings): published lessons
   * in published chapters, and how many of them the student completed, per
   * subject or per chapter. One grouped query.
   */
  async lessonCompletion(
    student: users,
    by: 'subject' | 'chapter',
    ids: bigint[],
  ): Promise<
    Map<
      bigint,
      { lessons_total: number; lessons_completed: number; percent: number }
    >
  > {
    const out = new Map<
      bigint,
      { lessons_total: number; lessons_completed: number; percent: number }
    >();
    if (!ids.length) return out;
    const key = by === 'subject' ? chapters.subject_id : chapters.id;
    const rows = await this.db
      .select({
        id: key,
        total: count(lessonsTable.id),
        done: count(lesson_progress.id),
      })
      .from(lessonsTable)
      .innerJoin(chapters, eq(chapters.id, lessonsTable.chapter_id))
      .leftJoin(
        lesson_progress,
        and(
          eq(lesson_progress.lesson_id, lessonsTable.id),
          eq(lesson_progress.student_id, student.id),
          eq(lesson_progress.status, 'completed'),
        ),
      )
      .where(
        and(
          inArray(key, ids),
          eq(chapters.is_published, true),
          eq(lessonsTable.is_published, true),
        ),
      )
      .groupBy(key);
    for (const id of ids) {
      const r = rows.find((x) => x.id === id);
      const total = r?.total ?? 0;
      const done = r?.done ?? 0;
      out.set(id, {
        lessons_total: total,
        lessons_completed: done,
        percent: total > 0 ? Math.round((done / total) * 100) : 0,
      });
    }
    return out;
  }

  chaptersFor(subjectId: bigint) {
    return this.db.query.chapters.findMany({
      where: and(
        eq(chapters.subject_id, subjectId),
        eq(chapters.is_published, true),
      ),
      orderBy: [asc(chapters.sort_order), asc(chapters.id)],
      extras: (t) => ({
        lessons_count: countOf(
          lessonsTable,
          'chapter_id',
          t.id,
          (c) => sql`${c('is_published')} = true`,
        ).as('lessons_count'),
      }),
    });
  }

  async findChapter(student: users, id: bigint) {
    const chapter = await this.db.query.chapters.findFirst({
      where: eq(chapters.id, id),
    });
    if (!chapter || !chapter.is_published) throw modelNotFound('Chapter', id);
    await this.authorizeSubjectId(student, chapter.subject_id);
    return chapter;
  }

  lessonsFor(chapterId: bigint) {
    return this.db.query.lessons.findMany({
      where: and(
        eq(lessonsTable.chapter_id, chapterId),
        eq(lessonsTable.is_published, true),
      ),
      orderBy: [asc(lessonsTable.sort_order), asc(lessonsTable.id)],
    });
  }

  async lessonDetail(student: users, lessonId: bigint) {
    const lesson = await this.db.query.lessons.findFirst({
      where: eq(lessonsTable.id, lessonId),
      with: { chapters: { with: { subjects: true } } },
    });
    if (!lesson || !lesson.is_published || !lesson.chapters.is_published)
      throw modelNotFound('Lesson', lessonId);
    await this.authorizeSubject(student, lesson.chapters.subjects);

    const progress = await this.db.query.lesson_progress.findFirst({
      where: and(
        eq(lesson_progress.student_id, student.id),
        eq(lesson_progress.lesson_id, lesson.id),
      ),
    });
    const siblings = await this.db.query.lessons.findMany({
      where: and(
        eq(lessonsTable.chapter_id, lesson.chapter_id),
        eq(lessonsTable.is_published, true),
      ),
      orderBy: [asc(lessonsTable.sort_order), asc(lessonsTable.id)],
      // sort_order and duration_sec are not in legacy (chapter playlist).
      columns: {
        id: true,
        title: true,
        type: true,
        sort_order: true,
        duration_sec: true,
      },
    });

    return {
      lesson,
      progress: {
        status: progress?.status ?? 'not_started',
        watched_seconds: progress?.watched_seconds ?? 0,
        progress_percent: progress?.progress_percent ?? 0,
      },
      siblings,
    };
  }

  async findLesson(student: users, id: bigint) {
    const lesson = await this.db.query.lessons.findFirst({
      where: eq(lessonsTable.id, id),
      with: { chapters: true },
    });
    if (!lesson || !lesson.is_published || !lesson.chapters.is_published)
      throw modelNotFound('Lesson', id);
    await this.authorizeSubjectId(student, lesson.chapters.subject_id);
    return lesson;
  }

  async recordProgress(
    student: users,
    lesson: lessons,
    watchedSeconds: number,
    completed?: boolean | null,
  ) {
    const key = { student_id: student.id, lesson_id: lesson.id };
    const existing = await this.db.query.lesson_progress.findFirst({
      where: and(
        eq(lesson_progress.student_id, key.student_id),
        eq(lesson_progress.lesson_id, key.lesson_id),
      ),
    });

    const duration = Math.max(1, lesson.duration_sec);
    const percent = Math.min(
      100,
      Math.round((watchedSeconds / duration) * 100),
    );
    const now = new Date();

    const data = {
      watched_seconds: Math.max(existing?.watched_seconds ?? 0, watchedSeconds),
      progress_percent: Math.max(existing?.progress_percent ?? 0, percent),
      last_viewed_at: now,
      status: existing?.status === 'completed' ? 'completed' : 'in_progress',
      completed_at: existing?.completed_at ?? null,
      updated_at: now,
    };
    if (completed ?? percent >= 90) {
      data.status = 'completed';
      data.completed_at = existing?.completed_at ?? now;
      data.progress_percent = 100;
    }

    const [row] = existing
      ? await this.db
          .update(lesson_progress)
          .set(data)
          .where(eq(lesson_progress.id, existing.id))
          .returning()
      : await this.db
          .insert(lesson_progress)
          .values({ ...key, ...data, created_at: now })
          .returning();
    return row;
  }

  /**
   * Completion and quiz-unlock state for a chapter (web lesson list and player):
   * finished lesson ids, whether all are done, the chapter's published quiz and
   * the student's latest submitted attempt.
   */
  async chapterQuizState(
    student: users,
    chapterId: bigint,
    lessonIds: bigint[],
  ) {
    const done = await this.db.query.lesson_progress.findMany({
      where: and(
        eq(lesson_progress.student_id, student.id),
        inArray(lesson_progress.lesson_id, lessonIds),
        eq(lesson_progress.status, 'completed'),
      ),
      columns: { lesson_id: true },
      orderBy: [asc(lesson_progress.id)],
    });
    const quiz = await this.db.query.quizzes.findFirst({
      where: and(
        eq(quizzesTable.chapter_id, chapterId),
        eq(quizzesTable.is_published, true),
      ),
      orderBy: [asc(quizzesTable.id)],
      extras: (t) => ({
        questions_count: countOf(questions, 'quiz_id', t.id).as(
          'questions_count',
        ),
      }),
    });
    const attempt = quiz
      ? await this.db.query.quiz_attempts.findFirst({
          where: and(
            eq(quizAttemptsTable.quiz_id, quiz.id),
            eq(quizAttemptsTable.student_id, student.id),
            eq(quizAttemptsTable.status, 'submitted'),
          ),
          orderBy: [
            myDesc(quizAttemptsTable.submitted_at),
            asc(quizAttemptsTable.id),
          ],
        })
      : null;

    return {
      completed_ids: done.map((d) => d.lesson_id),
      all_completed: lessonIds.length > 0 && done.length >= lessonIds.length,
      quiz: quiz
        ? {
            id: quiz.id,
            title: quiz.title,
            duration_min: quiz.duration_min,
            total_marks: quiz.total_marks,
            pass_marks: quiz.pass_marks,
            questions_count: quiz.questions_count,
          }
        : null,
      attempt: attempt
        ? {
            id: attempt.id,
            score: attempt.score,
            total_marks: attempt.total_marks,
            passed: attempt.score >= quiz!.pass_marks,
          }
        : null,
    };
  }

  async continueLearning(student: users, limit = 4) {
    const rows = await this.db.query.lesson_progress.findMany({
      where: and(
        eq(lesson_progress.student_id, student.id),
        ne(lesson_progress.status, 'completed'),
      ),
      orderBy: [
        myDesc(lesson_progress.last_viewed_at),
        asc(lesson_progress.id),
      ],
      limit,
      with: {
        lessons: { with: { chapters: { with: { subjects: true } } } },
      },
    });
    return rows.map((p) => ({
      lesson_id: p.lesson_id,
      title: p.lessons?.title ?? null,
      subject: p.lessons?.chapters?.subjects?.name ?? null,
      chapter: p.lessons?.chapters?.title ?? null,
      type: p.lessons?.type ?? null,
      progress_percent: p.progress_percent,
      last_viewed_at: diffForHumans(p.last_viewed_at),
    }));
  }

  async upcomingQuizzes(student: users, limit = 5, subjects?: subjects[]) {
    const subjectIds = (
      subjects ?? (await this.subjectsForStudent(student))
    ).map((s) => s.id);
    const attempted = await this.db.query.quiz_attempts.findMany({
      where: and(
        eq(quizAttemptsTable.student_id, student.id),
        inArray(quizAttemptsTable.status, ['in_progress', 'submitted']),
      ),
      columns: { quiz_id: true },
      orderBy: [asc(quizAttemptsTable.id)],
    });

    const rows = await this.db.query.quizzes.findMany({
      where: and(
        inArray(quizzesTable.subject_id, subjectIds),
        eq(quizzesTable.is_published, true),
        notInArray(
          quizzesTable.id,
          attempted.map((a) => a.quiz_id),
        ),
      ),
      orderBy: [myDesc(quizzesTable.created_at), asc(quizzesTable.id)],
      limit,
      with: {
        subjects: true,
        chapters: true,
      },
      extras: (t) => ({
        questions_count: countOf(questions, 'quiz_id', t.id).as(
          'questions_count',
        ),
      }),
    });
    return rows.map((q) => ({
      id: q.id,
      title: q.title,
      subject: q.subjects?.name ?? null,
      chapter: q.chapters?.title ?? null,
      duration_min: q.duration_min,
      total_marks: q.total_marks,
      questions_count: q.questions_count,
    }));
  }

  async findQuiz(student: users, id: bigint) {
    const quiz = await this.db.query.quizzes.findFirst({
      where: eq(quizzesTable.id, id),
      with: {
        subjects: true,
        chapters: true,
        questions: { orderBy: (t) => [asc(t.sort_order), asc(t.id)] },
      },
    });
    if (!quiz || !quiz.is_published) throw modelNotFound('Quiz', id);
    // security: not in legacy — authorise through the quiz's subject (or its
    // chapter's subject); a quiz with neither is not available.
    const subjectIds = [quiz.subject_id, quiz.chapters?.subject_id].filter(
      (v): v is bigint => v != null,
    );
    if (!subjectIds.length || (quiz.chapters && !quiz.chapters.is_published))
      throw modelNotFound('Quiz', id);
    for (const sid of new Set(subjectIds)) {
      await this.authorizeSubjectId(student, sid);
    }
    return quiz;
  }

  async startAttempt(student: users, quiz: quizzes): Promise<quiz_attempts> {
    const existing = await this.db.query.quiz_attempts.findFirst({
      where: and(
        eq(quizAttemptsTable.student_id, student.id),
        eq(quizAttemptsTable.quiz_id, quiz.id),
        eq(quizAttemptsTable.status, 'in_progress'),
      ),
      orderBy: [asc(quizAttemptsTable.id)],
    });
    if (existing) return existing;

    const now = new Date();
    const [row] = await this.db
      .insert(quizAttemptsTable)
      .values({
        student_id: student.id,
        quiz_id: quiz.id,
        status: 'in_progress',
        total_marks: quiz.total_marks,
        started_at: now,
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /** QuizController::guardAttempt + route binding. */
  async openAttempt(student: users, attemptId: bigint) {
    const attempt = await this.db.query.quiz_attempts.findFirst({
      where: eq(quizAttemptsTable.id, attemptId),
    });
    if (!attempt) throw modelNotFound('QuizAttempt', attemptId);
    if (attempt.student_id !== student.id)
      throw new ApiException('Not your attempt.', 403);
    if (attempt.status !== 'in_progress')
      throw new ApiException('Attempt is not open.', 422);
    return attempt;
  }

  async recordAnswer(
    attempt: quiz_attempts,
    questionId: number,
    answer: unknown[],
  ) {
    const question = await this.db.query.questions.findFirst({
      where: and(
        eq(questions.id, BigInt(questionId)),
        eq(questions.quiz_id, attempt.quiz_id),
      ),
      orderBy: [asc(questions.id)],
    });
    if (!question) throw modelNotFound('Question', questionId);

    const isCorrect = isAnswerCorrect(
      jsonCast<unknown[]>(question.correct_answer) ?? [],
      answer,
    );
    const now = new Date();
    const data = {
      answer: phpJsonEncode(answer),
      is_correct: isCorrect,
      marks_awarded: isCorrect ? question.marks : 0,
      updated_at: now,
    };
    await this.db
      .insert(quiz_answers)
      .values({
        attempt_id: attempt.id,
        question_id: question.id,
        ...data,
        created_at: now,
      })
      .onConflictDoUpdate({
        target: [quiz_answers.attempt_id, quiz_answers.question_id],
        set: data,
      });
    // security: not in legacy — no per-answer correctness feedback: answers can
    // be changed until submit, so it would let a student probe the answer key.
    // Neither client reads it (the result screen uses GET attempts/:id).
    return { question_id: question.id };
  }

  async submitAttempt(attempt: quiz_attempts) {
    const [sum] = await this.db
      .select({ marks_awarded: mySum(quiz_answers.marks_awarded) })
      .from(quiz_answers)
      .where(eq(quiz_answers.attempt_id, attempt.id));
    const now = new Date();
    const [row] = await this.db
      .update(quizAttemptsTable)
      .set({
        status: 'submitted',
        score: sum.marks_awarded ?? 0,
        submitted_at: now,
        updated_at: now,
      })
      .where(eq(quizAttemptsTable.id, attempt.id))
      .returning();
    return row;
  }

  /** Web quiz result screen: attempt with its quiz, subject and answered questions. */
  async attemptResult(student: users, attemptId: bigint) {
    const attempt = await this.db.query.quiz_attempts.findFirst({
      where: eq(quizAttemptsTable.id, attemptId),
      with: {
        quizzes: { with: { subjects: true, chapters: true } },
        quiz_answers: {
          with: { questions: true },
          orderBy: (t) => [asc(t.id)],
        },
      },
    });
    if (!attempt) throw modelNotFound('QuizAttempt', attemptId);
    if (attempt.student_id !== student.id)
      throw new ApiException('Not your attempt.', 403);
    return attempt;
  }

  /**
   * Evaluate a submitted attempt, award newly earned badges, and return the
   * celebration payload (null when the student failed or earned nothing new).
   */
  async awardQuizBadges(student: users, attempt: quiz_attempts) {
    const quiz = await this.db.query.quizzes.findFirst({
      where: eq(quizzesTable.id, attempt.quiz_id),
      with: { subjects: true },
    });
    if (!quiz) return null;

    const total = attempt.total_marks;
    const pct = total > 0 ? Math.round((attempt.score / total) * 100) : 0;
    if (attempt.score < quiz.pass_marks) return null;

    const seconds =
      attempt.started_at && attempt.submitted_at
        ? Math.abs(
            attempt.submitted_at.getTime() - attempt.started_at.getTime(),
          ) / 1000
        : null;
    const fast =
      seconds !== null &&
      quiz.duration_min > 0 &&
      seconds < quiz.duration_min * 60 * 0.5;

    const priorCount = await this.db.$count(
      quizAttemptsTable,
      and(
        eq(quizAttemptsTable.student_id, student.id),
        eq(quizAttemptsTable.status, 'submitted'),
        ne(quizAttemptsTable.id, attempt.id),
      ),
    );

    const keys: string[] = [];
    if (priorCount === 0) keys.push('first_steps');
    if (pct >= 100 && fast) keys.push('flawless_combo');
    else if (pct >= 100) keys.push('perfect_score');
    else if (pct >= 90) keys.push('quiz_conqueror');
    else if (pct >= 80) keys.push('sharp_mind');
    else keys.push('quiz_winner');
    if (fast && pct < 100) keys.push('fast_finisher');

    if (pct >= 80) {
      const subject = (quiz.subjects?.name ?? '').toLowerCase();
      if (subject.includes('math')) keys.push('number_ninja');
      else if (subject.includes('science')) keys.push('logic_explorer');
      else if (subject.includes('english') || subject.includes('language'))
        keys.push('word_wizard');
      else keys.push('concept_master');
    }

    const owned = new Set(
      (
        await this.db.query.achievements.findMany({
          where: and(
            eq(achievements.student_id, student.id),
            inArray(achievements.kind, keys),
          ),
          columns: { kind: true },
          orderBy: [asc(achievements.id)],
        })
      ).map((a) => a.kind),
    );
    const newKeys = [...new Set(keys)].filter((k) => !owned.has(k));
    if (!newKeys.length) return null;

    const now = new Date();
    const newBadges: Badge[] = [];
    for (const key of newKeys) {
      const b = getBadge(key);
      if (!b) continue;
      await this.db.insert(achievements).values({
        student_id: student.id,
        kind: key,
        title: b.title,
        icon: b.icon,
        meta: phpJsonEncode({
          tier: b.tier,
          xp: b.xp,
          desc: b.desc,
          quiz_id: Number(quiz.id),
        }),
        earned_at: now,
        created_at: now,
        updated_at: now,
      });
      newBadges.push(b);
    }

    // Headline = highest tier among newly earned (ties keep list order).
    newBadges.sort((a, b) => tierRank(b.tier) - tierRank(a.tier));
    const xpEarned = newBadges.reduce((n, b) => n + b.xp, 0);

    // Level progress (70 XP per level, matching the dashboard).
    const xp = await this.computeXp(student);
    const levelSize = XP_PER_LEVEL;
    const into = xp % levelSize;
    return {
      headline: newBadges[0],
      badges: newBadges,
      xp: xpEarned,
      score_percent: pct,
      progress: {
        level: Math.floor(xp / levelSize),
        from: Math.max(
          0,
          Math.round((Math.max(0, into - xpEarned / 10) / levelSize) * 100),
        ),
        to: Math.round((into / levelSize) * 100),
      },
    };
  }

  async profileSummary(student: users) {
    const attempts = await this.db.query.quiz_attempts.findMany({
      where: and(
        eq(quizAttemptsTable.student_id, student.id),
        eq(quizAttemptsTable.status, 'submitted'),
      ),
      orderBy: [asc(quizAttemptsTable.id)],
    });
    const pctSum = attempts.reduce(
      (n, a) => n + (a.total_marks > 0 ? (a.score / a.total_marks) * 100 : 0),
      0,
    );
    return {
      lessons_completed: await this.completedLessons(student),
      quizzes_attempted: attempts.length,
      avg_score_percent: attempts.length
        ? Math.round(pctSum / attempts.length)
        : 0,
      streak_days: await this.computeStreak(student),
      xp: await this.computeXp(student),
      achievements: await this.db.query.achievements.findMany({
        where: eq(achievements.student_id, student.id),
        orderBy: [desc(achievements.earned_at), asc(achievements.id)],
        limit: 6,
      }),
    };
  }

  /** Earned achievements keyed by kind (Collection::keyBy keeps the last row per key). */
  async earnedBadges(student: users) {
    const rows = await this.db.query.achievements.findMany({
      where: eq(achievements.student_id, student.id),
      orderBy: [desc(achievements.earned_at), asc(achievements.id)],
    });
    const map = new Map<string, { earned_at: Date; xp: number }>();
    for (const r of rows) {
      map.set(r.kind, {
        earned_at: r.earned_at,
        xp: Number(jsonCast<{ xp?: number }>(r.meta)?.xp ?? 0),
      });
    }
    return map;
  }

  private completedLessons(student: users) {
    return this.db.$count(
      lesson_progress,
      and(
        eq(lesson_progress.student_id, student.id),
        eq(lesson_progress.status, 'completed'),
      ),
    );
  }

  private async totalLessons(subjects: subjects[]) {
    if (!subjects.length) return 0;
    return this.db.$count(
      lessonsTable,
      and(
        eq(lessonsTable.is_published, true),
        inArray(
          lessonsTable.chapter_id,
          this.db
            .select({ id: chapters.id })
            .from(chapters)
            .where(
              inArray(
                chapters.subject_id,
                subjects.map((s) => s.id),
              ),
            ),
        ),
      ),
    );
  }

  /** Consecutive-day streak from lesson views; allows a single missed day, like the legacy code. */
  private async computeStreak(student: users) {
    const rows = await this.db.query.lesson_progress.findMany({
      where: and(
        eq(lesson_progress.student_id, student.id),
        isNotNull(lesson_progress.last_viewed_at),
      ),
      orderBy: [
        myDesc(lesson_progress.last_viewed_at),
        asc(lesson_progress.id),
      ],
      columns: { last_viewed_at: true },
    });
    const dates = [...new Set(rows.map((r) => dateString(r.last_viewed_at!)))];

    const cursor = new Date(`${dateString(new Date())}T00:00:00Z`);
    const shift = (days: number) =>
      cursor.setUTCDate(cursor.getUTCDate() - days);
    const dayBefore = () => dateString(new Date(cursor.getTime() - 86400_000));

    let streak = 0;
    for (const date of dates) {
      if (date === dateString(cursor)) {
        streak++;
        shift(1);
      } else if (date === dayBefore()) {
        streak++;
        shift(2);
      } else break;
    }
    return streak;
  }

  private async computeXp(student: users) {
    const completed = await this.completedLessons(student);
    const [quiz] = await this.db
      .select({ score: mySum(quizAttemptsTable.score) })
      .from(quizAttemptsTable)
      .where(
        and(
          eq(quizAttemptsTable.student_id, student.id),
          eq(quizAttemptsTable.status, 'submitted'),
        ),
      );
    return completed * 50 + (quiz.score ?? 0) * 10;
  }
}

/** 70 XP per level, as the legacy dashboard view computes it. */
export const XP_PER_LEVEL = 70;

export function levelInfo(xp: number) {
  const level = Math.floor(xp / XP_PER_LEVEL);
  const next = (level + 1) * XP_PER_LEVEL;
  return {
    level,
    next_level_xp: next,
    xp_to_next: next - xp,
    level_percent: Math.round((xp / next) * 100),
  };
}

/** sort() both and compare strictly, like the PHP version (types matter: 1 !== "1"). */
function isAnswerCorrect(correct: unknown[], given: unknown[]): boolean {
  const norm = (a: unknown[]) =>
    JSON.stringify(
      [...a].sort((x, y) => {
        if (typeof x !== typeof y) return typeof x < typeof y ? -1 : 1;
        return (x as number) < (y as number)
          ? -1
          : (x as number) > (y as number)
            ? 1
            : 0;
      }),
    );
  return norm(correct) === norm(given);
}
