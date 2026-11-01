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
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { toModel } from '../common/http/eloquent';
import { modelNotFound, routeId } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc, countOf, myDesc } from '../db/helpers';
import {
  chapters as chaptersTable,
  lessons as lessonsTable,
  questions as questionsTable,
  quizzes as quizzesTable,
  subjects as subjectsTable,
} from '../db/schema';
import type { users } from '../db/types';
import { strRandom } from '../storage/laravel-str';
import { StorageService } from '../storage/storage.service';
import type { IncomingFile } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFiles,
} from '../storage/uploads';
import { ContentService } from './content.service';

type Files = Partial<Record<'content_file' | 'thumbnail_file', IncomingFile[]>>;

const LESSON_RULES = {
  title: ['required', 'string', 'max:160'],
  type: ['required', 'in:video,pdf,text'],
  content_url: ['nullable', 'url'],
  content_body: ['nullable', 'string'],
  thumbnail: ['nullable', 'url'],
  // Auto-extracted from the uploaded video by the form; a JPEG data URL.
  thumbnail_data: ['nullable', 'string', 'max:5000000'],
  duration_sec: ['nullable', 'integer', 'min:0'],
  is_free: ['nullable', 'boolean'],
  is_published: ['nullable', 'boolean'],
};

const LESSON_FILES = [
  { field: 'content_file', kind: 'file' as const, maxKb: 204800 },
  { field: 'thumbnail_file', kind: 'image' as const, maxKb: 10240 },
];

const QUIZ_RULES = {
  title: ['required', 'string', 'max:160'],
  description: ['nullable', 'string'],
  subject_id: ['nullable', 'exists:subjects,id'],
  chapter_id: ['nullable', 'exists:chapters,id'],
  duration_min: ['required', 'integer', 'min:1', 'max:300'],
  pass_marks: ['nullable', 'integer', 'min:0'],
};

/**
 * /api/v1/content/* — new endpoints for the super admin content library,
 * ported from Web\ContentController (legacy had these as web routes only).
 */
@Controller('content')
@Roles(Role.SuperAdmin)
export class ContentController {
  constructor(
    private readonly content: ContentService,
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  private async subject(raw: string) {
    const id = routeId(raw, 'Subject');
    const s = await this.db.query.subjects.findFirst({
      where: eq(subjectsTable.id, id),
    });
    if (!s) throw modelNotFound('Subject', id);
    return s;
  }

  private async chapter(raw: string) {
    const id = routeId(raw, 'Chapter');
    const c = await this.db.query.chapters.findFirst({
      where: eq(chaptersTable.id, id),
      with: { subjects: true },
    });
    if (!c) throw modelNotFound('Chapter', id);
    return c;
  }

  private async lesson(raw: string) {
    const id = routeId(raw, 'Lesson');
    const l = await this.db.query.lessons.findFirst({
      where: eq(lessonsTable.id, id),
      with: { chapters: { with: { subjects: true } } },
    });
    if (!l) throw modelNotFound('Lesson', id);
    return l;
  }

  private async quiz(raw: string) {
    const id = routeId(raw, 'Quiz');
    const q = await this.db.query.quizzes.findFirst({
      where: eq(quizzesTable.id, id),
    });
    if (!q) throw modelNotFound('Quiz', id);
    return q;
  }

  @Get()
  async library(@CurrentUser() user: users) {
    const { subjects, totals } = await this.content.library(user);
    return ok({
      subjects: subjects.map(({ chapters_count, quizzes_count, ...s }) =>
        toModel('subjects', s, { chapters_count, quizzes_count }),
      ),
      totals,
    });
  }

  @Get('subjects/:subject')
  async subjectShow(@CurrentUser() user: users, @Param('subject') raw: string) {
    const subject = await this.subject(raw);
    this.content.guardSubject(user, subject);
    const chapters = await this.content.chaptersFor(subject);
    return ok({
      subject: toModel('subjects', subject),
      chapters: chapters.map(({ lessons_count, ...c }) =>
        toModel('chapters', c, { lessons_count }),
      ),
    });
  }

  @Post('subjects/:subject/chapters')
  async chapterStore(
    @CurrentUser() user: users,
    @Param('subject') raw: string,
    @Body() body: unknown,
  ) {
    const subject = await this.subject(raw);
    this.content.guardSubject(user, subject);
    const data = await laravelValidate(this.db, body, {
      title: ['required', 'string', 'max:160'],
      description: ['nullable', 'string'],
      sort_order: ['nullable', 'integer', 'min:0', 'max:999'],
      is_published: ['nullable', 'boolean'],
    });
    const c = await this.content.createChapter(subject, data);
    return ok({ id: c.id }, 'Chapter created.');
  }

  @Delete('chapters/:chapter')
  async chapterDelete(
    @CurrentUser() user: users,
    @Param('chapter') raw: string,
  ) {
    const chapter = await this.chapter(raw);
    this.content.guardSubject(user, chapter.subjects);
    await this.content.deleteChapter(chapter);
    return ok({ subject_id: chapter.subject_id }, 'Chapter deleted.');
  }

  @Get('chapters/:chapter')
  async chapterShow(@CurrentUser() user: users, @Param('chapter') raw: string) {
    const { subjects: subject, ...chapter } = await this.chapter(raw);
    this.content.guardSubject(user, subject);
    const lessons = await this.db.query.lessons.findMany({
      where: eq(lessonsTable.chapter_id, chapter.id),
      orderBy: [asc(lessonsTable.sort_order), asc(lessonsTable.id)],
    });
    return ok({
      chapter: toModel('chapters', chapter, {
        subject: toModel('subjects', subject),
        lessons: lessons.map((l) => toModel('lessons', l)),
      }),
    });
  }

  /**
   * Decode a `data:image/…;base64,…` thumbnail into storage. Null for a
   * malformed input or one over 5 MB, like saveDataUrlThumbnail.
   */
  private async dataUrlThumbnail(dataUrl: string, chapterId: bigint) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
    if (!m || !/^[A-Za-z0-9+/]*={0,2}$/.test(m[2])) return null;
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 5 * 1024 * 1024) return null;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    return this.storage.putBytes(
      `lessons/${chapterId}/thumbnails/auto-${strRandom(10)}.${ext}`,
      bytes,
      `image/${m[1]}`,
    );
  }

  /** Validated lesson upload fields plus the files, in legacy rule order. */
  private validateLesson(body: unknown, files: Files, update: boolean) {
    const { duration_sec, is_free, is_published, ...head } = LESSON_RULES;
    const rules = {
      title: head.title,
      type: head.type,
      content_url: head.content_url,
      content_file: [],
      content_body: head.content_body,
      thumbnail: head.thumbnail,
      thumbnail_file: [],
      thumbnail_data: head.thumbnail_data,
      duration_sec,
      ...(update && {
        sort_order: ['nullable', 'integer', 'min:0', 'max:999'],
      }),
      is_free,
      is_published,
    };
    return validateWithFiles(
      this.db,
      body,
      rules,
      {
        content_file: files.content_file?.[0],
        thumbnail_file: files.thumbnail_file?.[0],
      },
      LESSON_FILES,
    );
  }

  private storeMedia(file: IncomingFile, type: unknown, folder: string) {
    return storeOrReject('content_file', () =>
      this.storage.store(file, type === 'pdf' ? 'pdf' : 'video', folder),
    );
  }

  private storeThumb(file: IncomingFile, folder: string) {
    return storeOrReject('thumbnail_file', () =>
      this.storage.store(file, 'image', `${folder}/thumbnails`),
    );
  }

  @Post('chapters/:chapter/lessons')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'content_file', maxCount: 1 },
        { name: 'thumbnail_file', maxCount: 1 },
      ],
      uploadOptions(205, 2),
    ),
  )
  async lessonStore(
    @CurrentUser() user: users,
    @Param('chapter') raw: string,
    @Body() body: unknown,
    @UploadedFiles() files: Files = {},
  ) {
    const { subjects: subject, ...chapter } = await this.chapter(raw);
    this.content.guardSubject(user, subject);
    const data = await this.validateLesson(body, files, false);
    const folder = `lessons/${chapter.id}`;
    const media = files.content_file?.[0];
    const thumb = files.thumbnail_file?.[0];

    if (media)
      data.content_url = await this.storeMedia(media, data.type, folder);
    // Thumbnail precedence: explicit upload → explicit URL → auto-extracted from video.
    if (thumb) {
      data.thumbnail = await this.storeThumb(thumb, folder);
    } else if (!data.thumbnail && data.thumbnail_data) {
      data.thumbnail = await this.dataUrlThumbnail(
        data.thumbnail_data as string,
        chapter.id,
      );
    }
    delete data.thumbnail_data;

    const l = await this.content.createLesson(chapter, data);
    return ok({ id: l.id }, 'Lesson added.');
  }

  @Get('lessons/:lesson')
  async lessonShow(@CurrentUser() user: users, @Param('lesson') raw: string) {
    const { chapters: chapter, ...lesson } = await this.lesson(raw);
    this.content.guardSubject(user, chapter?.subjects ?? null);
    const { subjects: subject, ...ch } = chapter;
    return ok({
      lesson: toModel('lessons', lesson, {
        chapter: toModel('chapters', ch, {
          subject: toModel('subjects', subject),
        }),
      }),
    });
  }

  @Patch('lessons/:lesson')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'content_file', maxCount: 1 },
        { name: 'thumbnail_file', maxCount: 1 },
      ],
      uploadOptions(205, 2),
    ),
  )
  async lessonUpdate(
    @CurrentUser() user: users,
    @Param('lesson') raw: string,
    @Body() body: unknown,
    @UploadedFiles() files: Files = {},
  ) {
    const { chapters: chapter, ...lesson } = await this.lesson(raw);
    this.content.guardSubject(user, chapter?.subjects ?? null);
    const data = await this.validateLesson(body, files, true);
    const folder = `lessons/${lesson.chapter_id}`;
    const media = files.content_file?.[0];
    const thumb = files.thumbnail_file?.[0];

    // Replacement video / PDF: store the new file, then delete the old one.
    if (media) {
      const url = await this.storeMedia(media, data.type, folder);
      await this.storage.delete(lesson.content_url);
      data.content_url = url;
    } else {
      // `$request->filled('content_url')`: keep the existing media unless a URL was given.
      data.content_url = data.content_url ?? lesson.content_url;
    }

    // Thumbnail precedence: upload → auto-extracted frame → typed URL → existing.
    const auto =
      !thumb && data.thumbnail_data
        ? await this.dataUrlThumbnail(
            data.thumbnail_data as string,
            lesson.chapter_id,
          )
        : null;
    if (thumb) {
      await this.storage.delete(lesson.thumbnail);
      data.thumbnail = await this.storeThumb(thumb, folder);
    } else if (auto) {
      await this.storage.delete(lesson.thumbnail);
      data.thumbnail = auto;
    } else {
      data.thumbnail = data.thumbnail ?? lesson.thumbnail;
    }
    delete data.thumbnail_data;

    await this.content.updateLesson(lesson, data);
    return ok({ chapter_id: lesson.chapter_id }, 'Lesson updated.');
  }

  @Delete('lessons/:lesson')
  async lessonDelete(@CurrentUser() user: users, @Param('lesson') raw: string) {
    const { chapters: chapter, ...lesson } = await this.lesson(raw);
    this.content.guardSubject(user, chapter?.subjects ?? null);
    await this.content.deleteLesson(lesson);
    return ok({ chapter_id: lesson.chapter_id }, 'Lesson deleted.');
  }

  @Get('quizzes')
  async quizBuilder(@CurrentUser() user: users) {
    const [subjects, quizzes] = await Promise.all([
      this.content.quizSubjects(user),
      this.db.query.quizzes.findMany({
        where: eq(quizzesTable.created_by, user.id),
        orderBy: [myDesc(quizzesTable.created_at), asc(quizzesTable.id)],
        with: { subjects: true, chapters: true },
        extras: (t) => ({
          questions_count: countOf(questionsTable, 'quiz_id', t.id).as(
            'questions_count',
          ),
        }),
      }),
    ]);
    return ok({
      subjects: subjects.map((s) => toModel('subjects', s)),
      quizzes: quizzes.map(
        ({ subjects: s, chapters: c, questions_count, ...q }) =>
          toModel('quizzes', q, {
            questions_count,
            subject: s ? toModel('subjects', s) : null,
            chapter: c ? toModel('chapters', c) : null,
          }),
      ),
    });
  }

  @Post('quizzes')
  async quizStore(@CurrentUser() user: users, @Body() body: unknown) {
    const data = await laravelValidate(this.db, body, QUIZ_RULES);
    const q = await this.content.createQuiz(user, data);
    return ok({ id: q.id }, 'Quiz created — add questions below.');
  }

  @Get('quizzes/:quiz')
  async quizEdit(@CurrentUser() user: users, @Param('quiz') raw: string) {
    const quiz = await this.quiz(raw);
    this.content.guardQuiz(user, quiz);
    const [questions, subjects, chapters] = await Promise.all([
      this.db.query.questions.findMany({
        where: eq(questionsTable.quiz_id, quiz.id),
        orderBy: [asc(questionsTable.sort_order), asc(questionsTable.id)],
      }),
      this.content.quizSubjects(user),
      quiz.subject_id
        ? this.db.query.chapters.findMany({
            where: eq(chaptersTable.subject_id, quiz.subject_id),
            orderBy: [asc(chaptersTable.sort_order), asc(chaptersTable.id)],
          })
        : [],
    ]);
    return ok({
      quiz: toModel('quizzes', quiz, {
        questions: questions.map((q) => toModel('questions', q)),
      }),
      subjects: subjects.map((s) => toModel('subjects', s)),
      chapters: chapters.map((c) => toModel('chapters', c)),
    });
  }

  @Patch('quizzes/:quiz')
  async quizUpdate(
    @CurrentUser() user: users,
    @Param('quiz') raw: string,
    @Body() body: unknown,
  ) {
    const quiz = await this.quiz(raw);
    this.content.guardQuiz(user, quiz);
    const data = await laravelValidate(this.db, body, {
      ...QUIZ_RULES,
      is_published: ['nullable', 'boolean'],
    });
    await this.content.updateQuiz(quiz, data);
    return ok({ id: quiz.id }, 'Quiz updated.');
  }

  @Post('quizzes/:quiz/questions')
  async questionStore(
    @CurrentUser() user: users,
    @Param('quiz') raw: string,
    @Body() body: unknown,
  ) {
    const quiz = await this.quiz(raw);
    this.content.guardQuiz(user, quiz);
    const data = await laravelValidate(this.db, body, {
      body: ['required', 'string'],
      type: ['required', 'in:mcq,tf,short'],
      marks: ['required', 'integer', 'min:1', 'max:50'],
      options: ['nullable', 'array'],
      'options.*': ['nullable', 'string', 'max:240'],
      correct_answer: ['required', 'string'],
      explanation: ['nullable', 'string'],
    });
    const q = await this.content.addQuestion(quiz, data);
    return ok({ id: q.id }, 'Question added.');
  }

  @Delete('questions/:question')
  @HttpCode(200)
  async questionDelete(
    @CurrentUser() user: users,
    @Param('question') raw: string,
  ) {
    const id = routeId(raw, 'Question');
    const question = await this.db.query.questions.findFirst({
      where: eq(questionsTable.id, id),
    });
    if (!question) throw modelNotFound('Question', id);
    const quiz = await this.db.query.quizzes.findFirst({
      where: eq(quizzesTable.id, question.quiz_id),
    });
    this.content.guardQuiz(user, quiz ?? null);
    await this.content.deleteQuestion(question);
    return ok({ quiz_id: question.quiz_id }, 'Question removed.');
  }
}
