import { BODY_MAX, DESCRIPTION_MAX, URL_MAX } from '../common/http/rules';
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
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { RateLimit } from '../common/decorators/rate-limit';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { and, eq, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { Readable } from 'node:stream';
import {
  CurrentUser,
  Public,
  Roles,
} from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { ApiException, ValidationFailed } from '../common/http/api.exception';
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
  users as usersTable,
} from '../db/schema';
import type { lessons, users } from '../db/types';
import { fileKeyOf, ForgedFileUrl, unsignFileUrl } from '../storage/file-url';
import { strRandom } from '../storage/laravel-str';
import {
  StorageService,
  VIDEO_IMPORTS_PREFIX,
} from '../storage/storage.service';
import {
  ALLOWED,
  DIRECT_VIDEO_MAX_BYTES,
  type IncomingFile,
  looksLikeVideo,
  VIDEO_CONTENT_TYPES,
} from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFiles,
} from '../storage/uploads';
import {
  apiOrigin,
  lessonVersion,
  signUpload,
  verifyUpload,
} from '../video/direct-upload';
import { lessonPlayback } from '../video/lesson-playback';
import { VideoJobs } from '../video/video-jobs.service';
import { ContentService } from './content.service';

/** security: not in legacy: lessons as returned here, with private files signed and `playback`. */
const lessonModel = (l: lessons, relations: Record<string, unknown> = {}) =>
  toModel('lessons', l, { playback: lessonPlayback(l), ...relations });

/**
 * Where an uploaded lesson file ended up: a stored value, or (not in legacy) a
 * temporary private object that the `video-transcode` job turns into
 * encrypted HLS.
 */
type StoredMedia = {
  content_url: string | null;
  video_status: 'processing' | null;
  video_upload_key: string | null;
  video_hls_path: null;
  video_hls_key: null;
};
const NO_VIDEO = {
  video_status: null,
  video_upload_key: null,
  video_hls_path: null,
  video_hls_key: null,
} as const;

type Files = Partial<Record<'content_file' | 'thumbnail_file', IncomingFile[]>>;

const LESSON_RULES = {
  title: ['required', 'string', 'max:160'],
  type: ['required', 'in:video,pdf,text'],
  content_url: ['nullable', 'url', `max:${URL_MAX}`],
  content_body: ['nullable', 'string', `max:${BODY_MAX}`],
  thumbnail: ['nullable', 'url', `max:${URL_MAX}`],
  // Auto-extracted from the uploaded video by the form; a JPEG data URL.
  thumbnail_data: ['nullable', 'string', 'max:5000000'],
  duration_sec: ['nullable', 'integer', 'min:0', 'max:86400'],
  is_free: ['nullable', 'boolean'],
  is_published: ['nullable', 'boolean'],
};

const LESSON_FILES = [
  { field: 'content_file', kind: 'file' as const, maxKb: 204800 },
  { field: 'thumbnail_file', kind: 'image' as const, maxKb: 10240 },
];

const QUIZ_RULES = {
  title: ['required', 'string', 'max:160'],
  description: ['nullable', 'string', `max:${DESCRIPTION_MAX}`],
  subject_id: ['nullable', 'exists:subjects,id'],
  chapter_id: ['nullable', 'exists:chapters,id'],
  duration_min: ['required', 'integer', 'min:1', 'max:300'],
  pass_marks: ['nullable', 'integer', 'min:0', 'max:10000'],
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
    private readonly videoJobs: VideoJobs,
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
      description: ['nullable', 'string', `max:${DESCRIPTION_MAX}`],
      sort_order: ['nullable', 'integer', 'min:0', 'max:999'],
      is_published: ['nullable', 'boolean'],
    });
    const c = await this.content.createChapter(subject, data);
    return ok({ id: c.id, url_slug: c.url_slug }, 'Chapter created.');
  }

  @Delete('chapters/:chapter')
  async chapterDelete(
    @CurrentUser() user: users,
    @Param('chapter') raw: string,
  ) {
    const chapter = await this.chapter(raw);
    this.content.guardSubject(user, chapter.subjects);
    // security: not in legacy: the cascade removes the lessons; their HLS
    // videos are deleted too (best-effort).
    const videos = await this.db.query.lessons.findMany({
      where: eq(lessonsTable.chapter_id, chapter.id),
      columns: { video_hls_path: true, video_upload_key: true },
      orderBy: [asc(lessonsTable.id)],
    });
    await this.content.deleteChapter(chapter);
    await this.videoJobs.deleteHls(...videos.map((v) => v.video_hls_path));
    for (const v of videos)
      if (v.video_upload_key)
        await this.storage.deletePrivate(v.video_upload_key);
    return ok(
      {
        subject_id: chapter.subject_id,
        subject_slug: chapter.subjects?.url_slug ?? null, // not in legacy: url_slug
      },
      'Chapter deleted.',
    );
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
        lessons: lessons.map((l) => lessonModel(l)),
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
      { private: true }, // security: not in legacy
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

  /**
   * security: not in legacy. Uploaded PDFs/files go to private storage
   * (`/files/<key>`); videos are kept privately under `video-imports/` until
   * the `video-transcode` job has made encrypted HLS of them (the caller
   * starts it once the lesson row is saved). Never served as uploaded.
   */
  private async storeMedia(
    file: IncomingFile,
    type: unknown,
    folder: string,
  ): Promise<StoredMedia> {
    const category = type === 'pdf' ? 'pdf' : 'video';
    if (category === 'video') {
      const url = await storeOrReject('content_file', () =>
        this.storage.store(file, 'video', `${VIDEO_IMPORTS_PREFIX}${folder}`, {
          private: true,
        }),
      );
      return {
        ...NO_VIDEO,
        content_url: null,
        video_status: 'processing',
        video_upload_key: fileKeyOf(url),
      };
    }
    const url = await storeOrReject('content_file', () =>
      this.storage.store(file, category, folder, { private: true }),
    );
    return { ...NO_VIDEO, content_url: url };
  }

  /** not in legacy: removes an upload still waiting for its `video-transcode` job (the job then stops). */
  private async dropUpload(lesson: lessons) {
    if (lesson.video_upload_key)
      await this.storage.deletePrivate(lesson.video_upload_key);
  }

  private storeThumb(file: IncomingFile, folder: string) {
    return storeOrReject('thumbnail_file', () =>
      this.storage.store(file, 'image', `${folder}/thumbnails`, {
        private: true, // security: not in legacy
      }),
    );
  }

  /**
   * security: not in legacy. Our own signed links sent back by the edit form
   * (`content_url`, `thumbnail`) are stored as `/files/<key>` again; a forged
   * one is a validation error, worded like Laravel's `url` rule.
   */
  private unsignFields(data: Record<string, unknown>) {
    const errors: Record<string, string[]> = {};
    for (const field of ['content_url', 'thumbnail']) {
      try {
        if (field in data) data[field] = unsignFileUrl(data[field]);
      } catch (e) {
        if (!(e instanceof ForgedFileUrl)) throw e;
        errors[field] = [
          `The ${field.replace(/_/g, ' ')} field must be a valid URL.`,
        ];
      }
    }
    if (Object.keys(errors).length) throw new ValidationFailed(errors);
  }

  @Post('chapters/:chapter/lessons')
  @RateLimit(10, 'user') // security: not in legacy: counted before the upload is buffered
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
    this.unsignFields(data);
    const folder = `lessons/${chapter.id}`;
    const media = files.content_file?.[0];
    const thumb = files.thumbnail_file?.[0];

    if (media)
      Object.assign(data, await this.storeMedia(media, data.type, folder));
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
    if (l.video_upload_key)
      await this.videoJobs.startTranscode(l.id, l.video_upload_key);
    return ok({ id: l.id, url_slug: l.url_slug }, 'Lesson added.');
  }

  /**
   * not in legacy: large lesson video upload (docs/video-hls-contract.md). The
   * browser PUTs the file to this API's own host (`stream` below), which
   * streams it into storage; local disk answers `multipart` (the file goes with
   * the lesson form, 200 MB).
   */
  @Post('lessons/:lesson/video-upload')
  @HttpCode(200)
  async videoUpload(
    @CurrentUser() user: users,
    @Param('lesson') raw: string,
    @Body() body: unknown,
  ) {
    const { chapters: chapter, ...lesson } = await this.lesson(raw);
    this.content.guardSubject(user, chapter?.subjects ?? null);
    const data = await laravelValidate(this.db, body, {
      filename: ['required', 'string', 'max:255'],
      size: ['required', 'integer', 'min:1'],
      content_type: ['required', 'string', 'max:100'],
    });
    const filename = data.filename as string;
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    if (!filename.includes('.') || !ALLOWED.video.includes(ext))
      throw ValidationFailed.field(
        'filename',
        `Extension .${ext} not allowed for video.`,
      );
    if (!VIDEO_CONTENT_TYPES.includes(data.content_type as string))
      throw ValidationFailed.field(
        'content_type',
        `MIME type ${String(data.content_type)} does not match a permitted video type.`,
      );
    if (Number(data.size) > DIRECT_VIDEO_MAX_BYTES)
      throw ValidationFailed.field(
        'size',
        'File exceeds the 5 GB limit for video uploads.',
      );
    if (!(await this.storage.r2Config())) return ok({ mode: 'multipart' });

    const { token, exp } = signUpload({
      lesson: String(lesson.id),
      user: String(user.id),
      filename,
      size: Number(data.size),
      type: data.content_type as string,
      ver: lessonVersion(lesson),
    });
    return ok({
      mode: 'stream',
      upload_url: `${apiOrigin()}/api/v1/content/lessons/${lesson.id}/video-upload/stream?t=${token}`,
      expires_at: new Date(exp * 1000).toISOString(),
    });
  }

  /**
   * not in legacy: the raw file, no Bearer (the signed `t` authorises it; see
   * client-ip.ts). Streams into storage, then replaces the lesson's video as
   * a multipart upload does. The body is never buffered whole: the video
   * content type is not parsed by Nest's JSON/urlencoded parsers.
   */
  @Public()
  @Roles()
  @Put('lessons/:lesson/video-upload/stream')
  @HttpCode(200)
  async videoUploadStream(
    @Param('lesson') raw: string,
    @Query('t') t: string,
    @Req() req: Request,
  ) {
    const grant = verifyUpload(t);
    if (!grant || grant.lesson !== String(routeId(raw, 'Lesson')))
      throw new ApiException('The upload link is invalid or has expired.', 403);
    const user = await this.db.query.users.findFirst({
      where: eq(usersTable.id, BigInt(grant.user)),
    });
    if (!user || user.status !== 'active')
      throw new ApiException('The upload link is invalid or has expired.', 403);
    const { chapters: chapter, ...lesson } = await this.lesson(raw);
    this.content.guardSubject(user, chapter?.subjects ?? null);
    // security: not in legacy: single use, and only for the lesson as it was when issued.
    if (grant.ver !== lessonVersion(lesson))
      throw new ApiException('The upload link is invalid or has expired.', 403);

    const length = req.headers['content-length'];
    if (
      !length ||
      Number(length) !== grant.size ||
      grant.size > DIRECT_VIDEO_MAX_BYTES
    ) {
      req.resume();
      throw ValidationFailed.field(
        'size',
        'Content-Length must equal the size the upload was started with.',
      );
    }

    // First chunk: must look like a video before anything is stored.
    const chunks = req[Symbol.asyncIterator]();
    let head = Buffer.alloc(0);
    let ended = false;
    while (head.length < 4096 && !ended) {
      const n = await chunks.next();
      if (n.done) ended = true;
      else head = Buffer.concat([head, n.value as Buffer]);
    }
    if (!looksLikeVideo(head))
      throw ValidationFailed.field(
        'file',
        'The file is not a permitted video type.',
      );

    const ext = grant.filename.split('.').pop()!.toLowerCase();
    const key = this.storage.videoImportKey(
      `lessons/${lesson.chapter_id}`,
      grant.filename,
      ext,
    );
    let received = 0;
    const body = Readable.from(
      (async function* () {
        received += head.length;
        yield head;
        while (!ended) {
          const n = await chunks.next();
          if (n.done) return;
          received += (n.value as Buffer).length;
          yield n.value as Buffer;
        }
      })(),
      { objectMode: false },
    );
    try {
      await this.storage.putPrivateStream(key, body, grant.type);
      if (received !== grant.size)
        throw ValidationFailed.field(
          'size',
          'The file size does not match the size the upload was started with.',
        );
    } catch (e) {
      await this.storage.deletePrivate(key);
      throw e;
    }

    // The update only matches the lesson as it was when the link was issued, so of two
    // parallel PUTs with one link only one wins (the other's file is removed).
    const [won] = await this.db
      .update(lessonsTable)
      .set({
        ...NO_VIDEO,
        content_url: null,
        video_status: 'processing',
        video_upload_key: key,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(lessonsTable.id, lesson.id),
          lesson.updated_at
            ? eq(lessonsTable.updated_at, lesson.updated_at)
            : isNull(lessonsTable.updated_at),
          lesson.video_upload_key
            ? eq(lessonsTable.video_upload_key, lesson.video_upload_key)
            : isNull(lessonsTable.video_upload_key),
          lesson.video_hls_path
            ? eq(lessonsTable.video_hls_path, lesson.video_hls_path)
            : isNull(lessonsTable.video_hls_path),
        ),
      )
      .returning({ id: lessonsTable.id });
    if (!won) {
      await this.storage.deletePrivate(key);
      throw new ApiException('The upload link is invalid or has expired.', 403);
    }
    await this.storage.delete(lesson.content_url);
    await this.videoJobs.deleteHls(lesson.video_hls_path);
    await this.dropUpload(lesson);
    await this.videoJobs.startTranscode(lesson.id, key);
    return this.lessonShow(user, raw);
  }

  @Get('lessons/:lesson')
  async lessonShow(@CurrentUser() user: users, @Param('lesson') raw: string) {
    const { chapters: chapter, ...lesson } = await this.lesson(raw);
    this.content.guardSubject(user, chapter?.subjects ?? null);
    const { subjects: subject, ...ch } = chapter;
    return ok({
      lesson: lessonModel(lesson, {
        chapter: toModel('chapters', ch, {
          subject: toModel('subjects', subject),
        }),
      }),
    });
  }

  @Patch('lessons/:lesson')
  @RateLimit(10, 'user') // security: not in legacy: counted before the upload is buffered
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
    this.unsignFields(data);
    const folder = `lessons/${lesson.chapter_id}`;
    const media = files.content_file?.[0];
    const thumb = files.thumbnail_file?.[0];

    // Replacement video / PDF: store the new file, then delete the old one.
    if (media) {
      const stored = await this.storeMedia(media, data.type, folder);
      await this.storage.delete(lesson.content_url);
      // security: not in legacy: the replaced HLS video goes too (best-effort),
      // and an upload still being transcoded.
      await this.videoJobs.deleteHls(lesson.video_hls_path);
      await this.dropUpload(lesson);
      Object.assign(data, stored);
    } else if (data.content_url) {
      // A typed URL replaces an HLS video (security: not in legacy).
      await this.videoJobs.deleteHls(lesson.video_hls_path);
      await this.dropUpload(lesson);
      Object.assign(data, NO_VIDEO);
    } else {
      // `$request->filled('content_url')`: keep the existing media unless a URL was given.
      data.content_url = lesson.content_url;
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

    const saved = await this.content.updateLesson(lesson, data);
    if (
      saved.video_upload_key &&
      saved.video_upload_key !== lesson.video_upload_key
    )
      await this.videoJobs.startTranscode(lesson.id, saved.video_upload_key);
    return ok(
      {
        chapter_id: lesson.chapter_id,
        chapter_slug: chapter?.url_slug ?? null, // not in legacy: url_slug
        url_slug: lesson.url_slug, // not in legacy
      },
      'Lesson updated.',
    );
  }

  @Delete('lessons/:lesson')
  async lessonDelete(@CurrentUser() user: users, @Param('lesson') raw: string) {
    const { chapters: chapter, ...lesson } = await this.lesson(raw);
    this.content.guardSubject(user, chapter?.subjects ?? null);
    await this.content.deleteLesson(lesson);
    // security: not in legacy: the lesson's HLS video goes too (best-effort).
    await this.videoJobs.deleteHls(lesson.video_hls_path);
    await this.dropUpload(lesson);
    return ok(
      {
        chapter_id: lesson.chapter_id,
        chapter_slug: chapter?.url_slug ?? null, // not in legacy: url_slug
      },
      'Lesson deleted.',
    );
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
    return ok(
      { id: q.id, slug: q.slug },
      'Quiz created — add questions below.',
    );
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
    return ok({ id: quiz.id, slug: quiz.slug }, 'Quiz updated.');
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
      body: ['required', 'string', 'max:5000'],
      type: ['required', 'in:mcq,tf,short'],
      marks: ['required', 'integer', 'min:1', 'max:50'],
      options: ['nullable', 'array', 'max:10'],
      'options.*': ['nullable', 'string', 'max:240'],
      correct_answer: ['required', 'string', 'max:500'],
      explanation: ['nullable', 'string', 'max:2000'],
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
    return ok(
      { quiz_id: question.quiz_id, quiz_slug: quiz?.slug ?? null }, // quiz_slug: not in legacy
      'Question removed.',
    );
  }
}
