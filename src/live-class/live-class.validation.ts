import { eq } from 'drizzle-orm';
import { ValidationFailed } from '../common/http/api.exception';
import type { Db } from '../db/db';
import { classes, subjects, syllabi } from '../db/schema';
import type { ScheduleInput } from './live-class.service';

/**
 * Port of the rules in Teacher\LiveClassApiController::store, with Laravel's
 * messages and semantics: `nullable` skips a missing field's other rules,
 * `required_if` is implicit, and `min`/`max` compare numbers for integer fields
 * and string length otherwise.
 */

type Body = Record<string, unknown>;

const present = (v: unknown) => v !== null && v !== undefined;
const label = (field: string) => field.replace(/_/g, ' ');
/** Scalar input as a string (Laravel compares raw request values). */
const str = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : '';
const isInt = (v: unknown) =>
  (typeof v === 'number' && Number.isInteger(v)) ||
  (typeof v === 'string' && /^[+-]?\d+$/.test(v));

export { parseLaravelDate } from '../common/http/laravel';
import { parseLaravelDate } from '../common/http/laravel';

function isUrl(v: string) {
  try {
    const u = new URL(v);
    return /^(https?|ftp|ftps|sftp|wss?):$/.test(u.protocol) && !!u.hostname;
  } catch {
    return false;
  }
}

async function exists(
  db: Db,
  table: 'classes' | 'syllabi' | 'subjects',
  v: unknown,
) {
  if (!isInt(v)) return false;
  const id = BigInt(String(v));
  if (table === 'classes')
    return !!(await db.query.classes.findFirst({ where: eq(classes.id, id) }));
  if (table === 'syllabi')
    return !!(await db.query.syllabi.findFirst({ where: eq(syllabi.id, id) }));
  return !!(await db.query.subjects.findFirst({ where: eq(subjects.id, id) }));
}

export async function validateSchedule(
  db: Db,
  body: Body,
): Promise<ScheduleInput> {
  const errors: Record<string, string[]> = {};
  const fail = (field: string, msg: string) => (errors[field] ??= []).push(msg);

  const sizeRule = (
    field: string,
    v: unknown,
    min: number | null,
    max: number | null,
    numeric: boolean,
  ) => {
    const size =
      numeric && isInt(v)
        ? Number(v)
        : typeof v === 'string'
          ? [...v].length
          : Number(v);
    const unit = numeric ? '' : ' characters';
    if (min !== null && size < min)
      fail(field, `The ${label(field)} field must be at least ${min}${unit}.`);
    if (max !== null && size > max)
      fail(
        field,
        `The ${label(field)} field must not be greater than ${max}${unit}.`,
      );
  };

  // title: required|string|max:200
  if (!present(body.title)) fail('title', 'The title field is required.');
  else if (typeof body.title !== 'string')
    fail('title', 'The title field must be a string.');
  else sizeRule('title', body.title, null, 200, false);

  // description: nullable|string|max:1000
  if (present(body.description)) {
    if (typeof body.description !== 'string')
      fail('description', 'The description field must be a string.');
    else sizeRule('description', body.description, null, 1000, false);
  }

  // scope_type: required|in:class,syllabus,school
  if (!present(body.scope_type))
    fail('scope_type', 'The scope type field is required.');
  else if (!['class', 'syllabus', 'school'].includes(str(body.scope_type))) {
    fail('scope_type', 'The selected scope type is invalid.');
  }

  // class_id / syllabus_id: nullable|exists|required_if:scope_type,<scope>
  for (const [field, table, scope] of [
    ['class_id', 'classes', 'class'],
    ['syllabus_id', 'syllabi', 'syllabus'],
  ] as const) {
    if (present(body[field])) {
      if (!(await exists(db, table, body[field])))
        fail(field, `The selected ${label(field)} is invalid.`);
    } else if (body.scope_type === scope) {
      fail(
        field,
        `The ${label(field)} field is required when scope type is ${scope}.`,
      );
    }
  }

  // subject_id: nullable|exists:subjects,id
  if (
    present(body.subject_id) &&
    !(await exists(db, 'subjects', body.subject_id))
  ) {
    fail('subject_id', 'The selected subject id is invalid.');
  }

  // scheduled_at: required|date|after:now
  let when: ReturnType<typeof parseLaravelDate> = null;
  if (!present(body.scheduled_at))
    fail('scheduled_at', 'The scheduled at field is required.');
  else {
    when =
      typeof body.scheduled_at === 'string'
        ? parseLaravelDate(body.scheduled_at)
        : null;
    if (!when)
      fail('scheduled_at', 'The scheduled at field must be a valid date.');
    if (!when || when.instant.getTime() <= Date.now()) {
      fail('scheduled_at', 'The scheduled at field must be a date after now.');
    }
  }

  // duration_min: required|integer|min:5|max:480
  if (!present(body.duration_min))
    fail('duration_min', 'The duration min field is required.');
  else {
    if (!isInt(body.duration_min))
      fail('duration_min', 'The duration min field must be an integer.');
    sizeRule('duration_min', body.duration_min, 5, 480, true);
  }

  // provider: required|in:jitsi,external
  if (!present(body.provider))
    fail('provider', 'The provider field is required.');
  else if (!['jitsi', 'external'].includes(str(body.provider))) {
    fail('provider', 'The selected provider is invalid.');
  }

  // meeting_url: nullable|url|max:500|required_if:provider,external
  if (present(body.meeting_url)) {
    const v = str(body.meeting_url);
    if (!isUrl(v))
      fail('meeting_url', 'The meeting url field must be a valid URL.');
    // security: not in legacy — only https links (no http/ftp/ws schemes) are
    // handed to students.
    else if (!/^https:\/\//i.test(v))
      fail('meeting_url', 'The meeting url field must use https.');
    sizeRule('meeting_url', v, null, 500, false);
  } else if (body.provider === 'external') {
    fail(
      'meeting_url',
      'The meeting url field is required when provider is external.',
    );
  }

  if (Object.keys(errors).length) throw new ValidationFailed(errors);

  const scope = body.scope_type as 'class' | 'syllabus' | 'school';
  const num = (v: unknown) => (present(v) ? Number(v) : null);
  return {
    title: body.title as string,
    description: (body.description as string | null) ?? null,
    class_id: scope === 'class' ? num(body.class_id) : null,
    syllabus_id: scope === 'syllabus' ? num(body.syllabus_id) : null,
    subject_id: num(body.subject_id),
    scheduled_at: when!.stored,
    duration_min: Number(body.duration_min),
    provider: body.provider as 'jitsi' | 'external',
    meeting_url: (body.meeting_url as string | null) ?? null,
  };
}
