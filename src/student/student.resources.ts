import type {
  chapters,
  lessons,
  questions,
  quizzes,
  subjects,
} from '../db/types';
import { iso8601, jsonCast } from '../common/http/laravel';
import { signedFileUrl } from '../storage/file-url';
import { lessonPlayback } from '../video/lesson-playback';

/** Ports of App\Http\Resources\{Subject,Chapter,Lesson,Quiz}Resource. */

export function subjectResource(s: subjects, chaptersCount?: number) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    grade: s.grade,
    icon: s.icon,
    color: s.color,
    description: s.description,
    ...(chaptersCount !== undefined && { chapters_count: chaptersCount }),
  };
}

export function chapterResource(c: chapters, lessonsCount?: number) {
  return {
    id: c.id,
    subject_id: c.subject_id,
    title: c.title,
    slug: c.slug,
    description: c.description,
    sort_order: c.sort_order,
    ...(lessonsCount !== undefined && { lessons_count: lessonsCount }),
  };
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

type LessonWithChapter = lessons & {
  chapters?: chapters & { subjects?: subjects | null };
};

/**
 * `content_body` is only included on the lesson detail endpoint. The legacy
 * resource meant to do the same (`routeIs('*.show')`), but API routes are
 * unnamed so it never fired there. Additive and intentional; see migration plan.
 */
export function lessonResource(
  l: LessonWithChapter,
  opts: { withBody?: boolean } = {},
) {
  return {
    id: l.id,
    chapter_id: l.chapter_id,
    title: l.title,
    slug: l.slug,
    type: l.type,
    // security: not in legacy: private files come out as signed links, and
    // `playback` says whether to fetch a VdoCipher OTP (/lessons/:id/playback).
    thumbnail: signedFileUrl(l.thumbnail),
    content_url: signedFileUrl(l.content_url),
    playback: lessonPlayback(l),
    ...(opts.withBody && { content_body: l.content_body }),
    duration_sec: l.duration_sec,
    duration_label: formatDuration(l.duration_sec),
    is_free: l.is_free,
    sort_order: l.sort_order,
    ...(l.chapters && {
      chapter: {
        id: l.chapters.id,
        title: l.chapters.title,
        subject: l.chapters.subjects
          ? {
              id: l.chapters.subjects.id,
              name: l.chapters.subjects.name,
              icon: l.chapters.subjects.icon,
            }
          : null,
      },
    }),
  };
}

type QuizWith = quizzes & {
  subjects?: subjects | null;
  chapters?: chapters | null;
  questions?: questions[];
};

/** Keys of each question with null values are dropped (PHP array_filter). */
export function quizResource(q: QuizWith) {
  return {
    id: q.id,
    title: q.title,
    description: q.description,
    duration_min: q.duration_min,
    total_marks: q.total_marks,
    pass_marks: q.pass_marks,
    is_published: q.is_published,
    starts_at: iso8601(q.starts_at),
    ends_at: iso8601(q.ends_at),
    ...(q.subjects !== undefined && {
      subject: q.subjects
        ? { id: q.subjects.id, name: q.subjects.name, icon: q.subjects.icon }
        : null,
    }),
    ...(q.chapters !== undefined && {
      chapter: q.chapters
        ? { id: q.chapters.id, title: q.chapters.title }
        : null,
    }),
    ...(q.questions && {
      questions: q.questions.map((x) =>
        Object.fromEntries(
          Object.entries({
            id: x.id,
            body: x.body,
            type: x.type,
            marks: x.marks,
            options: jsonCast(x.options),
            // not in legacy: true when an mcq has several correct letters (answers stay hidden)
            multiple:
              x.type === 'mcq' &&
              (jsonCast<unknown[]>(x.correct_answer) ?? []).length > 1
                ? true
                : null,
            sort_order: x.sort_order,
          }).filter(([, v]) => v !== null),
        ),
      ),
    }),
  };
}
