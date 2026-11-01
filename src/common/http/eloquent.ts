import { eloquentRow } from './laravel';

/**
 * Model::toArray() settings ($casts, $hidden) per table, for endpoints that
 * return raw Eloquent models. Mirror the legacy app/Models/* when adding tables.
 */
const MODELS = {
  users: {
    hidden: ['password', 'remember_token', 'otp', 'otp_expires_at'],
    casts: {
      email_verified_at: 'datetime',
      phone_verified_at: 'datetime',
      last_login_at: 'datetime',
      dob: 'date',
    },
  },
  schools: {
    casts: {
      plan_expires_at: 'date',
      settings: 'array',
      max_teachers: 'int',
      max_students: 'int',
      ai_daily_token_limit: 'int',
    },
  },
  classes: {},
  subjects: { casts: { is_active: 'bool' } },
  chapters: { casts: { is_published: 'bool' } },
  quizzes: {
    casts: {
      shuffle_questions: 'bool',
      is_published: 'bool',
      starts_at: 'datetime',
      ends_at: 'datetime',
    },
  },
  assignments: { casts: { due_date: 'datetime', is_published: 'bool' } },
  assignment_submissions: {
    casts: { submitted_at: 'datetime', graded_at: 'datetime' },
  },
  attendance: { casts: { date: 'date' } },
  lessons: { casts: { is_free: 'bool', is_published: 'bool' } },
  questions: { casts: { options: 'array', correct_answer: 'array' } },
  syllabi: { casts: { is_active: 'bool' } },
  plans: {
    casts: { features: 'array', is_featured: 'bool', is_active: 'bool' },
  },
  student_enquiries: {},
  payments: {
    casts: { period_start: 'date', period_end: 'date', meta: 'array' },
  },
  invoices: {
    casts: {
      issued_at: 'datetime',
      paid_at: 'datetime',
      email_sent_at: 'datetime',
      meta: 'array',
    },
  },
  subscriptions: {
    casts: {
      trial_ends_at: 'datetime',
      current_period_start: 'date',
      current_period_end: 'date',
      meta: 'array',
    },
  },
  // CMS (App\Models\Cms\*)
  services: { casts: { is_featured: 'bool', is_active: 'bool' } },
  features: { casts: { is_active: 'bool' } },
  faqs: { casts: { is_active: 'bool' } },
  testimonials: {
    casts: { rating: 'int', is_featured: 'bool', is_active: 'bool' },
  },
  team_members: { casts: { socials: 'array', is_active: 'bool' } },
  blog_categories: { casts: { is_active: 'bool' } },
  social_links: { casts: { is_active: 'bool' } },
  blog_posts: { casts: { published_at: 'datetime', is_featured: 'bool' } },
  tags: {},
  pages: { casts: { schema: 'array', is_system: 'bool', noindex: 'bool' } },
  page_sections: { casts: { data: 'array', is_active: 'bool' } },
  navigation_menus: {},
  menu_items: { casts: { is_active: 'bool' } },
  media: { casts: { size: 'int', width: 'int', height: 'int' } },
  media_folders: {},
  site_settings: { casts: { value: 'array' } },
  contact_messages: {},
  newsletter_subscribers: { casts: { confirmed_at: 'datetime' } },
  demo_requests: {},
} as const;

export type ModelTable = keyof typeof MODELS;

/** Serialise a database row like `$model->toArray()` (columns only; add relations explicitly). */
export function toModel(
  table: ModelTable,
  row: object,
  relations: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...eloquentRow(row as Record<string, unknown>, MODELS[table]),
    ...relations,
  };
}

/**
 * A related model loaded through belongsToMany: its columns plus `pivot`, whose
 * keys come in Laravel's order (foreign key, related key, withPivot columns,
 * timestamps). `pivotRow` is the pivot table row.
 */
export function withPivot(
  table: ModelTable,
  row: object,
  pivotRow: Record<string, unknown>,
  keys: { foreign: string; related: string; columns: string[] },
): Record<string, unknown> {
  const pivot: Record<string, unknown> = {
    [keys.foreign]: pivotRow[keys.foreign],
    [keys.related]: pivotRow[keys.related],
  };
  for (const c of keys.columns) pivot[c] = pivotRow[c];
  pivot.created_at = pivotRow.created_at;
  pivot.updated_at = pivotRow.updated_at;
  return toModel(table, row, { pivot: eloquentRow(pivot) });
}

/**
 * Eloquent's dirty check for `fill()->save()`: the fields whose value differs
 * from the loaded row (numbers and numeric strings compare as text, like
 * originalIsEquivalent). An empty result means save() writes nothing and
 * leaves updated_at alone.
 */
export function dirtyFields(
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const norm = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof Date) return v.toISOString();
    return typeof v === 'object'
      ? JSON.stringify(v)
      : (v as string | number | bigint).toString();
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([k, v]) => norm(row[k]) !== norm(v)),
  );
}

/** PHP `(bool)`: false for null, '', '0', 0 and false. */
export const phpBool = (v: unknown) =>
  !(
    v === null ||
    v === undefined ||
    v === false ||
    v === 0 ||
    v === '' ||
    v === '0'
  );
