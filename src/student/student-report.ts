import { phpRound } from '../common/http/laravel';

/** Pure helpers for the student PDF report (no database, unit-tested). */

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const pad = (n: number) => String(n).padStart(2, '0');

/** Carbon format('M j, Y'). */
export const mjY = (d: Date) =>
  `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
/** Carbon format('M Y'). */
export const mY = (d: Date) =>
  `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
/** Carbon format('g:i A'). */
export const gIA = (d: Date) => {
  const h = d.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * Illuminate\Support\Str::slug($title, '-'). Laravel transliterates to ASCII
 * first; this strips accents (NFKD) and drops characters with no Latin
 * equivalent. Known difference: names in non-Latin scripts (Telugu, Hindi)
 * transliterate in Laravel but vanish here.
 */
export function strSlug(title: string): string {
  const ascii = title.normalize('NFKD').replace(/\P{ASCII}/gu, '');
  return ascii
    .replace(/_+/g, '-')
    .replace(/@/g, '-at-')
    .toLowerCase()
    .replace(/[^-a-z0-9\s]+/g, '')
    .replace(/[-\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** RFC 5987 `value-chars`: percent-encode everything but attr-char. */
const rfc5987 = (v: string) =>
  encodeURIComponent(v).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Content-Disposition for the report download. Legacy: `bodhira-report-<slug>.pdf`.
 * not in legacy: a name with no Latin letters (Hindi, Telugu) slugs to '' and
 * would give `bodhira-report-.pdf`, so the plain `filename` falls back to
 * `progress-report-<id>.pdf`, and any name with non-ASCII characters also gets
 * an RFC 5987 `filename*` carrying the real name for clients that support it.
 */
export function reportContentDisposition(user: {
  id: number | bigint;
  name: string;
}): { filename: string; header: string } {
  const slug = strSlug(user.name);
  const filename = slug
    ? `bodhira-report-${slug}.pdf`
    : `progress-report-${user.id}.pdf`;
  let header = `attachment; filename="${filename}"`;
  // eslint-disable-next-line no-control-regex
  const display = user.name.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, ' ');
  const trimmed = display.replace(/\s+/g, ' ').trim();
  const clean = Array.from(trimmed).slice(0, 80).join('');
  if (clean && /\P{ASCII}/u.test(clean)) {
    header += `; filename*=UTF-8''${rfc5987(`bodhira-report-${clean}.pdf`)}`;
  }
  return { filename, header };
}

/** PHP truthiness of a string: '' and '0' are falsy. */
export const truthy = (s: string | null | undefined): s is string =>
  s !== null && s !== undefined && s !== '' && s !== '0';

export interface AttendanceSummary {
  total: number;
  present: number;
  late: number;
  excused: number;
  absent: number;
  percent: number;
}

/** The counts and percent of StudentController::profileExtras (`recent` and `records` are not in the report). */
export function attendanceSummary(statuses: string[]): AttendanceSummary {
  const n = (s: string) => statuses.filter((x) => x === s).length;
  const present = n('present');
  const late = n('late');
  const excused = n('excused');
  const absent = n('absent');
  const total = statuses.length;
  return {
    total,
    present,
    late,
    excused,
    absent,
    percent: total ? phpRound(((present + late + excused) / total) * 100) : 0,
  };
}

const SUBJECT_KEYWORDS = ['watching', 'reading', 'chapter', 'lesson', 'quiz'];

/**
 * Subject doubt vs other (general) doubt, from the conversation titles:
 * a title that contains a subject name or one of the keywords is a subject doubt.
 */
export function classifyAiSessions(
  titles: (string | null)[],
  subjectNames: (string | null)[],
) {
  const names = subjectNames
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());
  let subjectCount = 0;
  for (const raw of titles) {
    const t = (raw ?? '').toLowerCase();
    if (
      names.some((sn) => sn !== '' && t.includes(sn)) ||
      SUBJECT_KEYWORDS.some((kw) => t.includes(kw))
    ) {
      subjectCount++;
    }
  }
  const total = titles.length;
  const otherCount = Math.max(0, total - subjectCount);
  const denom = Math.max(1, total);
  return {
    subject_count: subjectCount,
    other_count: otherCount,
    subject_pct: phpRound((subjectCount / denom) * 100),
    other_pct: phpRound((otherCount / denom) * 100),
  };
}
