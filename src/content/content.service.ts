import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, max } from 'drizzle-orm';
import { dirtyFields, phpBool } from '../common/http/eloquent';
import { forbidden, phpJsonEncode } from '../common/http/laravel';
import { ApiException } from '../common/http/api.exception';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc, countOf, mySum } from '../db/helpers';
import {
  chapters as chaptersTable,
  lessons as lessonsTable,
  questions as questionsTable,
  quizzes as quizzesTable,
  subjects as subjectsTable,
} from '../db/schema';
import type {
  chapters,
  lessons,
  questions,
  quizzes,
  subjects,
  users,
} from '../db/types';
import { strRandom, strSlug } from '../storage/laravel-str';

type Data = Record<string, unknown>;

const int = (v: unknown) => Math.trunc(Number(v ?? 0)) || 0;
const id = (v: unknown) =>
  v === null || v === undefined ? null : BigInt(v as string);

/** Port of App\Services\ContentService plus the guards in Web\ContentController. */
@Injectable()
export class ContentService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** ContentController::guardSubject: another school's subject is 403 (bare abort). */
  guardSubject(user: users, subject: { school_id: bigint | null } | null) {
    if (!subject) throw new ApiException('HTTP error', 404);
    if (
      subject.school_id &&
      user.school_id &&
      subject.school_id !== user.school_id
    ) {
      throw forbidden();
    }
  }

  /** ContentController::guardQuiz: the author, a super admin, or an admin of the quiz's school. */
  guardQuiz(user: users, quiz: quizzes | null) {
    if (!quiz) throw new ApiException('HTTP error', 404);
    if (quiz.created_by !== user.id) {
      const admin = (user.role as Role) === Role.Admin;
      if (
        (user.role as Role) !== Role.SuperAdmin &&
        (!admin || quiz.school_id !== user.school_id)
      ) {
        throw forbidden();
      }
    }
  }

  /** Subjects visible to the user (all of them for a super admin). */
  private subjectScope(user: users) {
    return user.school_id
      ? eq(subjectsTable.school_id, user.school_id)
      : undefined;
  }

  async library(user: users) {
    const subjects = await this.db.query.subjects.findMany({
      where: this.subjectScope(user),
      orderBy: [asc(subjectsTable.name), asc(subjectsTable.id)],
      extras: (t) => ({
        chapters_count: countOf(chaptersTable, 'subject_id', t.id).as(
          'chapters_count',
        ),
        quizzes_count: countOf(quizzesTable, 'subject_id', t.id).as(
          'quizzes_count',
        ),
      }),
    });
    const ids = subjects.map((s) => s.id);
    return {
      subjects,
      totals: {
        subjects: subjects.length,
        chapters: await this.db.$count(
          chaptersTable,
          inArray(chaptersTable.subject_id, ids),
        ),
        lessons: await this.db.$count(
          lessonsTable,
          inArray(
            lessonsTable.chapter_id,
            this.db
              .select({ id: chaptersTable.id })
              .from(chaptersTable)
              .where(inArray(chaptersTable.subject_id, ids)),
          ),
        ),
        quizzes: await this.db.$count(
          quizzesTable,
          inArray(quizzesTable.subject_id, ids),
        ),
      },
    };
  }

  chaptersFor(subject: { id: bigint }) {
    return this.db.query.chapters.findMany({
      where: eq(chaptersTable.subject_id, subject.id),
      orderBy: [asc(chaptersTable.sort_order), asc(chaptersTable.id)],
      extras: (t) => ({
        lessons_count: countOf(lessonsTable, 'chapter_id', t.id).as(
          'lessons_count',
        ),
      }),
    });
  }

  async createChapter(subject: subjects, data: Data) {
    const [{ top }] = await this.db
      .select({ top: max(chaptersTable.sort_order) })
      .from(chaptersTable)
      .where(eq(chaptersTable.subject_id, subject.id));
    const now = new Date();
    const title = data.title as string;
    const [row] = await this.db
      .insert(chaptersTable)
      .values({
        subject_id: subject.id,
        title,
        slug: `${strSlug(title)}-${strRandom(4)}`,
        description: (data.description as string | null | undefined) ?? null,
        sort_order: int(data.sort_order ?? (top ?? 0) + 1),
        is_published: phpBool(data.is_published ?? true),
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  async deleteChapter(chapter: chapters) {
    await this.db.delete(chaptersTable).where(eq(chaptersTable.id, chapter.id));
  }

  async createLesson(chapter: chapters, data: Data) {
    const [{ top }] = await this.db
      .select({ top: max(lessonsTable.sort_order) })
      .from(lessonsTable)
      .where(eq(lessonsTable.chapter_id, chapter.id));
    const now = new Date();
    const title = data.title as string;
    const str = (k: string) => (data[k] as string | null | undefined) ?? null;
    const [row] = await this.db
      .insert(lessonsTable)
      .values({
        chapter_id: chapter.id,
        title,
        slug: `${strSlug(title)}-${strRandom(4)}`,
        type: (data.type as string | undefined) ?? 'video',
        thumbnail: str('thumbnail'),
        content_url: str('content_url'),
        content_body: str('content_body'),
        duration_sec: int(data.duration_sec),
        sort_order: int(data.sort_order ?? (top ?? 0) + 1),
        is_free: phpBool(data.is_free ?? false),
        is_published: phpBool(data.is_published ?? true),
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /** Only keys present in data change; the slug stays stable. */
  async updateLesson(lesson: lessons, data: Data) {
    const keep = (k: keyof lessons) => (k in data ? data[k] : lesson[k]);
    const fields = dirtyFields(lesson, {
      title: data.title ?? lesson.title,
      type: data.type ?? lesson.type,
      thumbnail: keep('thumbnail'),
      content_url: keep('content_url'),
      content_body: keep('content_body'),
      duration_sec: int(data.duration_sec ?? lesson.duration_sec),
      sort_order: int(data.sort_order ?? lesson.sort_order),
      is_free: phpBool(data.is_free ?? false),
      is_published: phpBool(data.is_published ?? false),
    });
    if (!Object.keys(fields).length) return lesson;
    const [row] = await this.db
      .update(lessonsTable)
      .set({ ...fields, updated_at: new Date() })
      .where(eq(lessonsTable.id, lesson.id))
      .returning();
    return row;
  }

  async deleteLesson(lesson: lessons) {
    await this.db.delete(lessonsTable).where(eq(lessonsTable.id, lesson.id));
  }

  quizSubjects(user: users) {
    return this.db.query.subjects.findMany({
      where: this.subjectScope(user),
      orderBy: [asc(subjectsTable.name), asc(subjectsTable.id)],
    });
  }

  async createQuiz(author: users, data: Data) {
    const now = new Date();
    const [row] = await this.db
      .insert(quizzesTable)
      .values({
        school_id: author.school_id,
        subject_id: id(data.subject_id),
        chapter_id: id(data.chapter_id),
        created_by: author.id,
        title: data.title as string,
        description: (data.description as string | null | undefined) ?? null,
        duration_min: int(data.duration_min ?? 15),
        total_marks: 0,
        pass_marks: int(data.pass_marks ?? 0),
        shuffle_questions: phpBool(data.shuffle_questions ?? true),
        is_published: phpBool(data.is_published ?? false),
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /** `$quiz->fill(collect($data)->only([...]))->save()`. */
  async updateQuiz(quiz: quizzes, data: Data) {
    const set: Data = {};
    for (const k of ['title', 'description'] as const)
      if (k in data) set[k] = data[k];
    for (const k of ['duration_min', 'pass_marks'] as const)
      if (k in data) set[k] = data[k] === null ? null : int(data[k]);
    for (const k of ['subject_id', 'chapter_id'] as const)
      if (k in data) set[k] = id(data[k]);
    if ('is_published' in data) set.is_published = phpBool(data.is_published);
    const fields = dirtyFields(quiz, set);
    if (!Object.keys(fields).length) return quiz;
    const [row] = await this.db
      .update(quizzesTable)
      .set({ ...fields, updated_at: new Date() })
      .where(eq(quizzesTable.id, quiz.id))
      .returning();
    return row;
  }

  /** ContentService::cleanOptions: drop blanks, keys from the original position (A, B, …). */
  private cleanOptions(options: unknown) {
    const clean: { key: string; text: string }[] = [];
    if (!options || typeof options !== 'object') return clean;
    for (const [i, opt] of Object.entries(options as Record<string, unknown>)) {
      if (typeof opt === 'string') {
        const text = opt.trim();
        if (text === '') continue;
        clean.push({ key: String.fromCharCode(65 + Number(i)), text });
      } else if (opt && typeof opt === 'object') {
        const o = opt as { key?: string; text?: unknown };
        const text = String((o.text as string | undefined) ?? '').trim();
        if (text === '') continue;
        clean.push({
          key: o.key ?? String.fromCharCode(65 + clean.length),
          text,
        });
      }
    }
    return clean;
  }

  async addQuestion(quiz: quizzes, data: Data) {
    const options = this.cleanOptions(data.options ?? []);
    // array_filter(array_map('trim', explode(',', …))): PHP drops '' and '0'.
    const correct = Array.isArray(data.correct_answer)
      ? (data.correct_answer as unknown[])
      : String((data.correct_answer as string | undefined) ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '' && s !== '0');
    const [{ top }] = await this.db
      .select({ top: max(questionsTable.sort_order) })
      .from(questionsTable)
      .where(eq(questionsTable.quiz_id, quiz.id));
    const now = new Date();
    const [q] = await this.db
      .insert(questionsTable)
      .values({
        quiz_id: quiz.id,
        body: data.body as string,
        type: (data.type as string | undefined) ?? 'mcq',
        marks: int(data.marks ?? 1),
        options: phpJsonEncode(options),
        correct_answer: phpJsonEncode(correct),
        explanation: (data.explanation as string | null | undefined) ?? null,
        sort_order: int(data.sort_order ?? (top ?? 0) + 1),
        created_at: now,
        updated_at: now,
      })
      .returning();
    await this.recomputeQuizMarks(quiz.id);
    return q;
  }

  async deleteQuestion(question: questions) {
    await this.db
      .delete(questionsTable)
      .where(eq(questionsTable.id, question.id));
    await this.recomputeQuizMarks(question.quiz_id);
  }

  private async recomputeQuizMarks(quizId: bigint) {
    const quiz = await this.db.query.quizzes.findFirst({
      where: eq(quizzesTable.id, quizId),
    });
    if (!quiz) return;
    const [sum] = await this.db
      .select({ marks: mySum(questionsTable.marks) })
      .from(questionsTable)
      .where(eq(questionsTable.quiz_id, quizId));
    const total = sum.marks ?? 0;
    const fields = dirtyFields(quiz, {
      total_marks: total,
      ...(quiz.pass_marks > total && { pass_marks: total }),
    });
    if (Object.keys(fields).length) {
      await this.db
        .update(quizzesTable)
        .set({ ...fields, updated_at: new Date() })
        .where(eq(quizzesTable.id, quizId));
    }
  }
}
