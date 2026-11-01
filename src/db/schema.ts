// Generated once from the legacy schema,
// now owned here: edit, then `npm run db:generate` (migrations in /drizzle). Table, column and relation names match the legacy schema.
// VARCHAR/CHAR columns are citext: legacy compared them
// case-insensitively, and the app depends on that (logins, slugs, uniques).
/* eslint-disable */
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { citext } from './citext';

export const achievements = pgTable(
  'achievements',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    student_id: bigint('student_id', { mode: 'bigint' }).notNull(),
    kind: citext('kind').notNull(),
    title: citext('title').notNull(),
    icon: citext('icon'),
    meta: text('meta'),
    earned_at: timestamp('earned_at', { mode: 'date', precision: 0 }).notNull(),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'achievements_student_id_foreign',
      columns: [t.student_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('achievements_student_id_index').on(t.student_id),
  ],
);

export const ai_chat_messages = pgTable(
  'ai_chat_messages',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    session_id: bigint('session_id', { mode: 'bigint' }).notNull(),
    role: citext('role').notNull(),
    content: text('content').notNull(),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    meta: text('meta'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'ai_chat_messages_session_id_foreign',
      columns: [t.session_id],
      foreignColumns: [ai_chat_sessions.id],
    }).onDelete('cascade'),
    index('ai_chat_messages_session_id_index').on(t.session_id),
  ],
);

export const ai_chat_sessions = pgTable(
  'ai_chat_sessions',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
    title: citext('title'),
    mode: citext('mode').notNull().default('chat'),
    last_message_at: timestamp('last_message_at', {
      mode: 'date',
      precision: 0,
    }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'ai_chat_sessions_user_id_foreign',
      columns: [t.user_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('ai_chat_sessions_user_id_index').on(t.user_id),
    // Not in legacy: the super admin's per-day counts (SuperService.aiUsage).
    index('ai_chat_sessions_created_at_index').on(t.created_at),
  ],
);

export const announcements = pgTable(
  'announcements',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    school_id: bigint('school_id', { mode: 'bigint' }),
    created_by: bigint('created_by', { mode: 'bigint' }),
    audience: citext('audience').notNull().default('all'),
    class_id: bigint('class_id', { mode: 'bigint' }),
    role: citext('role'),
    title: citext('title').notNull(),
    body: text('body').notNull(),
    published_at: timestamp('published_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'announcements_class_id_foreign',
      columns: [t.class_id],
      foreignColumns: [classes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'announcements_created_by_foreign',
      columns: [t.created_by],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'announcements_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('cascade'),
    index('announcements_class_id_index').on(t.class_id),
    index('announcements_created_by_index').on(t.created_by),
    index('announcements_school_id_index').on(t.school_id),
  ],
);

export const assignment_submissions = pgTable(
  'assignment_submissions',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    assignment_id: bigint('assignment_id', { mode: 'bigint' }).notNull(),
    student_id: bigint('student_id', { mode: 'bigint' }).notNull(),
    file_url: citext('file_url'),
    note: text('note'),
    status: citext('status').notNull().default('submitted'),
    score: bigint('score', { mode: 'number' }),
    feedback: text('feedback'),
    graded_by: bigint('graded_by', { mode: 'bigint' }),
    submitted_at: timestamp('submitted_at', { mode: 'date', precision: 0 }),
    graded_at: timestamp('graded_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'assignment_submissions_assignment_id_foreign',
      columns: [t.assignment_id],
      foreignColumns: [assignments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'assignment_submissions_graded_by_foreign',
      columns: [t.graded_by],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'assignment_submissions_student_id_foreign',
      columns: [t.student_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('assignment_submissions_assignment_id_student_id_unique').on(
      t.assignment_id,
      t.student_id,
    ),
    index('assignment_submissions_graded_by_index').on(t.graded_by),
    index('assignment_submissions_student_id_index').on(t.student_id),
  ],
);

export const assignments = pgTable(
  'assignments',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    class_id: bigint('class_id', { mode: 'bigint' }).notNull(),
    subject_id: bigint('subject_id', { mode: 'bigint' }),
    teacher_id: bigint('teacher_id', { mode: 'bigint' }).notNull(),
    title: citext('title').notNull(),
    description: text('description'),
    attachment_url: citext('attachment_url'),
    due_date: timestamp('due_date', { mode: 'date', precision: 0 }),
    max_marks: bigint('max_marks', { mode: 'number' }).notNull().default(100),
    is_published: boolean('is_published').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'assignments_class_id_foreign',
      columns: [t.class_id],
      foreignColumns: [classes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'assignments_subject_id_foreign',
      columns: [t.subject_id],
      foreignColumns: [subjects.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'assignments_teacher_id_foreign',
      columns: [t.teacher_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('assignments_class_id_index').on(t.class_id),
    index('assignments_subject_id_index').on(t.subject_id),
    index('assignments_teacher_id_index').on(t.teacher_id),
  ],
);

export const attendance = pgTable(
  'attendance',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    class_id: bigint('class_id', { mode: 'bigint' }).notNull(),
    student_id: bigint('student_id', { mode: 'bigint' }).notNull(),
    date: date('date', { mode: 'date' }).notNull(),
    status: citext('status').notNull().default('present'),
    marked_by: bigint('marked_by', { mode: 'bigint' }),
    remarks: citext('remarks'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'attendance_class_id_foreign',
      columns: [t.class_id],
      foreignColumns: [classes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'attendance_marked_by_foreign',
      columns: [t.marked_by],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'attendance_student_id_foreign',
      columns: [t.student_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('attendance_unique').on(t.class_id, t.student_id, t.date),
    index('attendance_marked_by_index').on(t.marked_by),
    index('attendance_student_id_index').on(t.student_id),
  ],
);

export const audit_logs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    user_id: bigint('user_id', { mode: 'bigint' }),
    school_id: bigint('school_id', { mode: 'bigint' }),
    action: citext('action').notNull(),
    subject_type: citext('subject_type'),
    subject_id: bigint('subject_id', { mode: 'bigint' }),
    changes: text('changes'),
    ip_address: citext('ip_address'),
    user_agent: citext('user_agent'),
    created_at: timestamp('created_at', {
      mode: 'date',
      precision: 0,
    }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'audit_logs_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'audit_logs_user_id_foreign',
      columns: [t.user_id],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    index('audit_logs_action_index').on(t.action),
    index('audit_logs_school_id_index').on(t.school_id),
    index('audit_logs_subject_type_subject_id_index').on(
      t.subject_type,
      t.subject_id,
    ),
    index('audit_logs_user_id_index').on(t.user_id),
  ],
);

export const blog_categories = pgTable(
  'blog_categories',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    name: citext('name').notNull(),
    slug: citext('slug').notNull(),
    description: citext('description'),
    sort_order: integer('sort_order').notNull().default(0),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [uniqueIndex('blog_categories_slug_unique').on(t.slug)],
);

export const blog_post_tag = pgTable(
  'blog_post_tag',
  {
    blog_post_id: bigint('blog_post_id', { mode: 'bigint' }).notNull(),
    tag_id: bigint('tag_id', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'blog_post_tag_blog_post_id_foreign',
      columns: [t.blog_post_id],
      foreignColumns: [blog_posts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'blog_post_tag_tag_id_foreign',
      columns: [t.tag_id],
      foreignColumns: [tags.id],
    }).onDelete('cascade'),
    primaryKey({ columns: [t.blog_post_id, t.tag_id] }),
    index('blog_post_tag_tag_id_index').on(t.tag_id),
  ],
);

export const blog_posts = pgTable(
  'blog_posts',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    blog_category_id: bigint('blog_category_id', { mode: 'bigint' }),
    author_id: bigint('author_id', { mode: 'bigint' }),
    title: citext('title').notNull(),
    slug: citext('slug').notNull(),
    excerpt: citext('excerpt'),
    body: text('body'),
    cover_image_url: citext('cover_image_url'),
    status: citext('status').notNull().default('draft'),
    published_at: timestamp('published_at', { mode: 'date', precision: 0 }),
    is_featured: boolean('is_featured').notNull().default(false),
    views: bigint('views', { mode: 'number' }).notNull().default(0),
    reading_minutes: integer('reading_minutes').notNull().default(0),
    meta_title: citext('meta_title'),
    meta_description: citext('meta_description'),
    og_image: citext('og_image'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
    deleted_at: timestamp('deleted_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    uniqueIndex('blog_posts_slug_unique').on(t.slug),
    foreignKey({
      name: 'blog_posts_author_id_foreign',
      columns: [t.author_id],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'blog_posts_blog_category_id_foreign',
      columns: [t.blog_category_id],
      foreignColumns: [blog_categories.id],
    }).onDelete('set null'),
    index('blog_posts_author_id_index').on(t.author_id),
    index('blog_posts_blog_category_id_index').on(t.blog_category_id),
    index('blog_posts_status_published_at_index').on(t.status, t.published_at),
  ],
);

export const cache = pgTable(
  'cache',
  {
    key: citext('key').primaryKey(),
    value: text('value').notNull(),
    expiration: bigint('expiration', { mode: 'bigint' }).notNull(),
  },
  (t) => [index('cache_expiration_index').on(t.expiration)],
);

export const cache_locks = pgTable(
  'cache_locks',
  {
    key: citext('key').primaryKey(),
    owner: citext('owner').notNull(),
    expiration: bigint('expiration', { mode: 'bigint' }).notNull(),
  },
  (t) => [index('cache_locks_expiration_index').on(t.expiration)],
);

export const chapters = pgTable(
  'chapters',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    subject_id: bigint('subject_id', { mode: 'bigint' }).notNull(),
    title: citext('title').notNull(),
    slug: citext('slug').notNull(),
    description: text('description'),
    sort_order: bigint('sort_order', { mode: 'number' }).notNull().default(0),
    is_published: boolean('is_published').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'chapters_subject_id_foreign',
      columns: [t.subject_id],
      foreignColumns: [subjects.id],
    }).onDelete('cascade'),
    index('chapters_subject_id_index').on(t.subject_id),
  ],
);

export const class_student = pgTable(
  'class_student',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    class_id: bigint('class_id', { mode: 'bigint' }).notNull(),
    student_id: bigint('student_id', { mode: 'bigint' }).notNull(),
    roll_no: citext('roll_no'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'class_student_class_id_foreign',
      columns: [t.class_id],
      foreignColumns: [classes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'class_student_student_id_foreign',
      columns: [t.student_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('class_student_class_id_student_id_unique').on(
      t.class_id,
      t.student_id,
    ),
    index('class_student_student_id_index').on(t.student_id),
  ],
);

export const class_subject = pgTable(
  'class_subject',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    class_id: bigint('class_id', { mode: 'bigint' }).notNull(),
    subject_id: bigint('subject_id', { mode: 'bigint' }).notNull(),
    teacher_id: bigint('teacher_id', { mode: 'bigint' }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'class_subject_class_id_foreign',
      columns: [t.class_id],
      foreignColumns: [classes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'class_subject_subject_id_foreign',
      columns: [t.subject_id],
      foreignColumns: [subjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'class_subject_teacher_id_foreign',
      columns: [t.teacher_id],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    uniqueIndex('class_subject_class_id_subject_id_unique').on(
      t.class_id,
      t.subject_id,
    ),
    index('class_subject_subject_id_index').on(t.subject_id),
    index('class_subject_teacher_id_index').on(t.teacher_id),
  ],
);

export const classes = pgTable(
  'classes',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    school_id: bigint('school_id', { mode: 'bigint' }).notNull(),
    grade: citext('grade').notNull(),
    section: citext('section').notNull(),
    class_teacher_id: bigint('class_teacher_id', { mode: 'bigint' }),
    academic_year: citext('academic_year'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'classes_class_teacher_id_foreign',
      columns: [t.class_teacher_id],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'classes_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('cascade'),
    uniqueIndex('classes_unique').on(
      t.school_id,
      t.grade,
      t.section,
      t.academic_year,
    ),
    index('classes_class_teacher_id_index').on(t.class_teacher_id),
  ],
);

export const contact_messages = pgTable(
  'contact_messages',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    name: citext('name').notNull(),
    email: citext('email').notNull(),
    phone: citext('phone'),
    subject: citext('subject'),
    message: text('message'),
    status: citext('status').notNull().default('new'),
    source: citext('source'),
    ip_address: citext('ip_address'),
    user_agent: citext('user_agent'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [index('contact_messages_status_index').on(t.status)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    user_one_id: bigint('user_one_id', { mode: 'bigint' }).notNull(),
    user_two_id: bigint('user_two_id', { mode: 'bigint' }).notNull(),
    last_message_at: timestamp('last_message_at', {
      mode: 'date',
      precision: 0,
    }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'conversations_user_one_id_foreign',
      columns: [t.user_one_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversations_user_two_id_foreign',
      columns: [t.user_two_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('conversations_user_one_id_user_two_id_unique').on(
      t.user_one_id,
      t.user_two_id,
    ),
    index('conversations_user_two_id_index').on(t.user_two_id),
  ],
);

export const demo_requests = pgTable(
  'demo_requests',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    type: citext('type').notNull(),
    name: citext('name').notNull(),
    email: citext('email').notNull(),
    phone: citext('phone').notNull(),
    city: citext('city'),
    board: citext('board'),
    organization: citext('organization'),
    designation: citext('designation'),
    student_count: citext('student_count'),
    grade: citext('grade'),
    message: text('message'),
    status: citext('status').notNull().default('new'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [index('demo_requests_type_status_index').on(t.type, t.status)],
);

export const discussions = pgTable(
  'discussions',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    lesson_id: bigint('lesson_id', { mode: 'bigint' }),
    user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
    parent_id: bigint('parent_id', { mode: 'bigint' }),
    body: text('body').notNull(),
    likes: bigint('likes', { mode: 'number' }).notNull().default(0),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
    deleted_at: timestamp('deleted_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'discussions_lesson_id_foreign',
      columns: [t.lesson_id],
      foreignColumns: [lessons.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'discussions_parent_id_foreign',
      columns: [t.parent_id],
      foreignColumns: [t.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'discussions_user_id_foreign',
      columns: [t.user_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('discussions_lesson_id_index').on(t.lesson_id),
    index('discussions_parent_id_index').on(t.parent_id),
    index('discussions_user_id_index').on(t.user_id),
  ],
);

export const failed_jobs = pgTable(
  'failed_jobs',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    uuid: citext('uuid').notNull(),
    connection: citext('connection').notNull(),
    queue: citext('queue').notNull(),
    payload: text('payload').notNull(),
    exception: text('exception').notNull(),
    failed_at: timestamp('failed_at', { mode: 'date', precision: 0 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('failed_jobs_uuid_unique').on(t.uuid),
    index('failed_jobs_connection_queue_failed_at_index').on(
      t.connection,
      t.queue,
      t.failed_at,
    ),
  ],
);

export const faqs = pgTable('faqs', {
  id: bigint('id', { mode: 'bigint' })
    .primaryKey()
    .generatedByDefaultAsIdentity(),
  category: citext('category'),
  question: citext('question').notNull(),
  answer: text('answer').notNull(),
  sort_order: integer('sort_order').notNull().default(0),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
  updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
});

export const features = pgTable('features', {
  id: bigint('id', { mode: 'bigint' })
    .primaryKey()
    .generatedByDefaultAsIdentity(),
  icon: citext('icon'),
  title: citext('title').notNull(),
  description: citext('description'),
  color: citext('color'),
  sort_order: integer('sort_order').notNull().default(0),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
  updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
});

export const invoices = pgTable(
  'invoices',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    number: citext('number').notNull(),
    user_id: bigint('user_id', { mode: 'bigint' }),
    school_id: bigint('school_id', { mode: 'bigint' }),
    subscription_id: bigint('subscription_id', { mode: 'bigint' }),
    payment_id: bigint('payment_id', { mode: 'bigint' }),
    plan_key: citext('plan_key').notNull(),
    plan_name: citext('plan_name').notNull(),
    cycle: citext('cycle').notNull().default('monthly'),
    amount_paise: bigint('amount_paise', { mode: 'bigint' }).notNull(),
    tax_rate_bps: integer('tax_rate_bps').notNull().default(0),
    tax_paise: bigint('tax_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    total_paise: bigint('total_paise', { mode: 'bigint' }).notNull(),
    currency: citext('currency').notNull().default('INR'),
    status: citext('status').notNull().default('pending'),
    issued_at: timestamp('issued_at', { mode: 'date', precision: 0 }).notNull(),
    paid_at: timestamp('paid_at', { mode: 'date', precision: 0 }),
    pdf_path: citext('pdf_path'),
    email_sent_at: timestamp('email_sent_at', { mode: 'date', precision: 0 }),
    billing_name: citext('billing_name'),
    billing_email: citext('billing_email'),
    billing_address: text('billing_address'),
    billing_gstin: citext('billing_gstin'),
    meta: text('meta'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    uniqueIndex('invoices_number_unique').on(t.number),
    foreignKey({
      name: 'invoices_payment_id_foreign',
      columns: [t.payment_id],
      foreignColumns: [payments.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'invoices_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'invoices_subscription_id_foreign',
      columns: [t.subscription_id],
      foreignColumns: [subscriptions.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'invoices_user_id_foreign',
      columns: [t.user_id],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    index('invoices_payment_id_index').on(t.payment_id),
    index('invoices_school_id_index').on(t.school_id),
    index('invoices_status_issued_at_index').on(t.status, t.issued_at),
    index('invoices_subscription_id_index').on(t.subscription_id),
    index('invoices_user_id_index').on(t.user_id),
  ],
);

export const job_batches = pgTable('job_batches', {
  id: citext('id').primaryKey(),
  name: citext('name').notNull(),
  total_jobs: integer('total_jobs').notNull(),
  pending_jobs: integer('pending_jobs').notNull(),
  failed_jobs: integer('failed_jobs').notNull(),
  failed_job_ids: text('failed_job_ids').notNull(),
  options: text('options'),
  cancelled_at: integer('cancelled_at'),
  created_at: integer('created_at').notNull(),
  finished_at: integer('finished_at'),
});

export const jobs = pgTable(
  'jobs',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    queue: citext('queue').notNull(),
    payload: text('payload').notNull(),
    attempts: integer('attempts').notNull(),
    reserved_at: bigint('reserved_at', { mode: 'number' }),
    available_at: bigint('available_at', { mode: 'number' }).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('jobs_queue_index').on(t.queue)],
);

export const lesson_progress = pgTable(
  'lesson_progress',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    student_id: bigint('student_id', { mode: 'bigint' }).notNull(),
    lesson_id: bigint('lesson_id', { mode: 'bigint' }).notNull(),
    status: citext('status').notNull().default('in_progress'),
    watched_seconds: bigint('watched_seconds', { mode: 'number' })
      .notNull()
      .default(0),
    progress_percent: smallint('progress_percent').notNull().default(0),
    last_viewed_at: timestamp('last_viewed_at', { mode: 'date', precision: 0 }),
    completed_at: timestamp('completed_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'lesson_progress_lesson_id_foreign',
      columns: [t.lesson_id],
      foreignColumns: [lessons.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'lesson_progress_student_id_foreign',
      columns: [t.student_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('lesson_progress_student_id_lesson_id_unique').on(
      t.student_id,
      t.lesson_id,
    ),
    index('lesson_progress_lesson_id_index').on(t.lesson_id),
    // Not in legacy: the super admin's per-day counts (SuperService.aiUsage).
    index('lesson_progress_last_viewed_at_index').on(t.last_viewed_at),
  ],
);

export const lessons = pgTable(
  'lessons',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    chapter_id: bigint('chapter_id', { mode: 'bigint' }).notNull(),
    title: citext('title').notNull(),
    slug: citext('slug').notNull(),
    type: citext('type').notNull().default('video'),
    thumbnail: citext('thumbnail'),
    content_url: citext('content_url'),
    content_body: text('content_body'),
    // security: not in legacy (Node-only column): the VdoCipher video id of an
    // uploaded lesson video. When set, content_url is null.
    video_id: text('video_id'),
    duration_sec: bigint('duration_sec', { mode: 'number' })
      .notNull()
      .default(0),
    sort_order: bigint('sort_order', { mode: 'number' }).notNull().default(0),
    is_free: boolean('is_free').notNull().default(false),
    is_published: boolean('is_published').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'lessons_chapter_id_foreign',
      columns: [t.chapter_id],
      foreignColumns: [chapters.id],
    }).onDelete('cascade'),
    index('lessons_chapter_id_index').on(t.chapter_id),
  ],
);

export const live_class_attendees = pgTable(
  'live_class_attendees',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    live_class_id: bigint('live_class_id', { mode: 'bigint' }).notNull(),
    user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
    joined_at: timestamp('joined_at', { mode: 'date', precision: 0 }),
    left_at: timestamp('left_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'live_class_attendees_live_class_id_foreign',
      columns: [t.live_class_id],
      foreignColumns: [live_classes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'live_class_attendees_user_id_foreign',
      columns: [t.user_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('live_class_attendees_live_class_id_user_id_unique').on(
      t.live_class_id,
      t.user_id,
    ),
    index('live_class_attendees_user_id_index').on(t.user_id),
  ],
);

export const live_classes = pgTable(
  'live_classes',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    host_id: bigint('host_id', { mode: 'bigint' }).notNull(),
    school_id: bigint('school_id', { mode: 'bigint' }),
    class_id: bigint('class_id', { mode: 'bigint' }),
    syllabus_id: bigint('syllabus_id', { mode: 'bigint' }),
    subject_id: bigint('subject_id', { mode: 'bigint' }),
    title: citext('title').notNull(),
    description: text('description'),
    scheduled_at: timestamp('scheduled_at', {
      mode: 'date',
      precision: 0,
    }).notNull(),
    duration_min: integer('duration_min').notNull().default(45),
    provider: citext('provider').notNull().default('jitsi'),
    meeting_url: citext('meeting_url'),
    meeting_room: citext('meeting_room'),
    recording_url: citext('recording_url'),
    status: citext('status').notNull().default('scheduled'),
    meta: text('meta'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'live_classes_class_id_foreign',
      columns: [t.class_id],
      foreignColumns: [classes.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'live_classes_host_id_foreign',
      columns: [t.host_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'live_classes_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'live_classes_subject_id_foreign',
      columns: [t.subject_id],
      foreignColumns: [subjects.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'live_classes_syllabus_id_foreign',
      columns: [t.syllabus_id],
      foreignColumns: [syllabi.id],
    }).onDelete('set null'),
    index('live_classes_class_id_scheduled_at_index').on(
      t.class_id,
      t.scheduled_at,
    ),
    index('live_classes_host_id_index').on(t.host_id),
    index('live_classes_scheduled_at_index').on(t.scheduled_at),
    index('live_classes_school_id_index').on(t.school_id),
    index('live_classes_subject_id_index').on(t.subject_id),
    index('live_classes_syllabus_id_scheduled_at_index').on(
      t.syllabus_id,
      t.scheduled_at,
    ),
  ],
);

export const media = pgTable(
  'media',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    media_folder_id: bigint('media_folder_id', { mode: 'bigint' }),
    disk: citext('disk').notNull().default('cloud'),
    path: citext('path').notNull(),
    url: citext('url').notNull(),
    mime: citext('mime'),
    size: bigint('size', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    width: bigint('width', { mode: 'number' }),
    height: bigint('height', { mode: 'number' }),
    alt: citext('alt'),
    title: citext('title'),
    original_name: citext('original_name'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'media_media_folder_id_foreign',
      columns: [t.media_folder_id],
      foreignColumns: [media_folders.id],
    }).onDelete('set null'),
    index('media_media_folder_id_index').on(t.media_folder_id),
  ],
);

export const media_folders = pgTable(
  'media_folders',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    parent_id: bigint('parent_id', { mode: 'bigint' }),
    name: citext('name').notNull(),
    slug: citext('slug').notNull(),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'media_folders_parent_id_foreign',
      columns: [t.parent_id],
      foreignColumns: [t.id],
    }).onDelete('cascade'),
    index('media_folders_parent_id_index').on(t.parent_id),
  ],
);

export const menu_items = pgTable(
  'menu_items',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    navigation_menu_id: bigint('navigation_menu_id', {
      mode: 'bigint',
    }).notNull(),
    parent_id: bigint('parent_id', { mode: 'bigint' }),
    label: citext('label').notNull(),
    url: citext('url').notNull(),
    target: citext('target').notNull().default('_self'),
    icon: citext('icon'),
    sort_order: integer('sort_order').notNull().default(0),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'menu_items_navigation_menu_id_foreign',
      columns: [t.navigation_menu_id],
      foreignColumns: [navigation_menus.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'menu_items_parent_id_foreign',
      columns: [t.parent_id],
      foreignColumns: [t.id],
    }).onDelete('cascade'),
    index('menu_items_navigation_menu_id_parent_id_sort_order_index').on(
      t.navigation_menu_id,
      t.parent_id,
      t.sort_order,
    ),
    index('menu_items_parent_id_index').on(t.parent_id),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    conversation_id: bigint('conversation_id', { mode: 'bigint' }).notNull(),
    sender_id: bigint('sender_id', { mode: 'bigint' }).notNull(),
    body: text('body').notNull(),
    read_at: timestamp('read_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'messages_conversation_id_foreign',
      columns: [t.conversation_id],
      foreignColumns: [conversations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'messages_sender_id_foreign',
      columns: [t.sender_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('messages_conversation_id_id_index').on(t.conversation_id, t.id),
    index('messages_sender_id_index').on(t.sender_id),
  ],
);

export const migrations = pgTable('migrations', {
  id: bigint('id', { mode: 'number' })
    .primaryKey()
    .generatedByDefaultAsIdentity(),
  migration: citext('migration').notNull(),
  batch: integer('batch').notNull(),
});

export const navigation_menus = pgTable(
  'navigation_menus',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    key: citext('key').notNull(),
    name: citext('name').notNull(),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [uniqueIndex('navigation_menus_key_unique').on(t.key)],
);

export const newsletter_subscribers = pgTable(
  'newsletter_subscribers',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    email: citext('email').notNull(),
    name: citext('name'),
    status: citext('status').notNull().default('subscribed'),
    ip_address: citext('ip_address'),
    confirmed_at: timestamp('confirmed_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [uniqueIndex('newsletter_subscribers_email_unique').on(t.email)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: citext('id').primaryKey(),
    type: citext('type').notNull(),
    notifiable_type: citext('notifiable_type').notNull(),
    notifiable_id: bigint('notifiable_id', { mode: 'bigint' }).notNull(),
    data: text('data').notNull(),
    read_at: timestamp('read_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    index('notifications_notifiable_type_notifiable_id_index').on(
      t.notifiable_type,
      t.notifiable_id,
    ),
  ],
);

export const page_sections = pgTable(
  'page_sections',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    page_id: bigint('page_id', { mode: 'bigint' }).notNull(),
    type: citext('type').notNull(),
    key: citext('key'),
    eyebrow: citext('eyebrow'),
    heading: citext('heading'),
    subheading: citext('subheading'),
    body: text('body'),
    media_url: citext('media_url'),
    data: text('data'),
    sort_order: integer('sort_order').notNull().default(0),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'page_sections_page_id_foreign',
      columns: [t.page_id],
      foreignColumns: [pages.id],
    }).onDelete('cascade'),
    index('page_sections_page_id_sort_order_index').on(t.page_id, t.sort_order),
  ],
);

export const pages = pgTable(
  'pages',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    slug: citext('slug').notNull(),
    name: citext('name').notNull(),
    template: citext('template').notNull().default('default'),
    status: citext('status').notNull().default('draft'),
    is_system: boolean('is_system').notNull().default(false),
    meta_title: citext('meta_title'),
    meta_description: citext('meta_description'),
    meta_keywords: citext('meta_keywords'),
    og_image: citext('og_image'),
    schema: text('schema'),
    noindex: boolean('noindex').notNull().default(false),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
    deleted_at: timestamp('deleted_at', { mode: 'date', precision: 0 }),
  },
  (t) => [uniqueIndex('pages_slug_unique').on(t.slug)],
);

export const parent_student = pgTable(
  'parent_student',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    parent_id: bigint('parent_id', { mode: 'bigint' }).notNull(),
    student_id: bigint('student_id', { mode: 'bigint' }).notNull(),
    relation: citext('relation'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'parent_student_parent_id_foreign',
      columns: [t.parent_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'parent_student_student_id_foreign',
      columns: [t.student_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('parent_student_parent_id_student_id_unique').on(
      t.parent_id,
      t.student_id,
    ),
    index('parent_student_student_id_index').on(t.student_id),
  ],
);

export const password_reset_tokens = pgTable('password_reset_tokens', {
  email: citext('email').primaryKey(),
  token: citext('token').notNull(),
  created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
});

export const payments = pgTable(
  'payments',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    school_id: bigint('school_id', { mode: 'bigint' }).notNull(),
    gateway: citext('gateway').notNull(),
    gateway_payment_id: citext('gateway_payment_id'),
    gateway_order_id: citext('gateway_order_id'),
    plan: citext('plan').notNull(),
    amount_paise: bigint('amount_paise', { mode: 'bigint' }).notNull(),
    currency: citext('currency').notNull().default('INR'),
    status: citext('status').notNull().default('pending'),
    period_start: date('period_start', { mode: 'date' }),
    period_end: date('period_end', { mode: 'date' }),
    meta: text('meta'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'payments_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('cascade'),
    index('payments_gateway_order_id_index').on(t.gateway_order_id),
    index('payments_gateway_payment_id_index').on(t.gateway_payment_id),
    index('payments_school_id_index').on(t.school_id),
  ],
);

export const personal_access_tokens = pgTable(
  'personal_access_tokens',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    tokenable_type: citext('tokenable_type').notNull(),
    tokenable_id: bigint('tokenable_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    token: citext('token').notNull(),
    abilities: text('abilities'),
    last_used_at: timestamp('last_used_at', { mode: 'date', precision: 0 }),
    expires_at: timestamp('expires_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    uniqueIndex('personal_access_tokens_token_unique').on(t.token),
    index('personal_access_tokens_expires_at_index').on(t.expires_at),
    index('personal_access_tokens_tokenable_type_tokenable_id_index').on(
      t.tokenable_type,
      t.tokenable_id,
    ),
  ],
);

export const plans = pgTable(
  'plans',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    key: citext('key').notNull(),
    audience: citext('audience').notNull().default('individual'),
    name: citext('name').notNull(),
    tagline: citext('tagline'),
    description: text('description'),
    features: text('features'),
    monthly_price: bigint('monthly_price', { mode: 'number' })
      .notNull()
      .default(0),
    yearly_price: bigint('yearly_price', { mode: 'number' })
      .notNull()
      .default(0),
    trial_days: integer('trial_days').notNull().default(0),
    is_featured: boolean('is_featured').notNull().default(false),
    is_active: boolean('is_active').notNull().default(true),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [uniqueIndex('plans_key_unique').on(t.key)],
);

export const questions = pgTable(
  'questions',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    quiz_id: bigint('quiz_id', { mode: 'bigint' }).notNull(),
    body: text('body').notNull(),
    type: citext('type').notNull().default('mcq'),
    marks: integer('marks').notNull().default(1),
    options: text('options'),
    correct_answer: text('correct_answer'),
    explanation: text('explanation'),
    sort_order: bigint('sort_order', { mode: 'number' }).notNull().default(0),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'questions_quiz_id_foreign',
      columns: [t.quiz_id],
      foreignColumns: [quizzes.id],
    }).onDelete('cascade'),
    index('questions_quiz_id_index').on(t.quiz_id),
  ],
);

export const quiz_answers = pgTable(
  'quiz_answers',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    attempt_id: bigint('attempt_id', { mode: 'bigint' }).notNull(),
    question_id: bigint('question_id', { mode: 'bigint' }).notNull(),
    answer: text('answer'),
    is_correct: boolean('is_correct').notNull().default(false),
    marks_awarded: integer('marks_awarded').notNull().default(0),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'quiz_answers_attempt_id_foreign',
      columns: [t.attempt_id],
      foreignColumns: [quiz_attempts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'quiz_answers_question_id_foreign',
      columns: [t.question_id],
      foreignColumns: [questions.id],
    }).onDelete('cascade'),
    uniqueIndex('quiz_answers_attempt_id_question_id_unique').on(
      t.attempt_id,
      t.question_id,
    ),
    index('quiz_answers_question_id_index').on(t.question_id),
  ],
);

export const quiz_attempts = pgTable(
  'quiz_attempts',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    quiz_id: bigint('quiz_id', { mode: 'bigint' }).notNull(),
    student_id: bigint('student_id', { mode: 'bigint' }).notNull(),
    status: citext('status').notNull().default('in_progress'),
    score: bigint('score', { mode: 'number' }).notNull().default(0),
    total_marks: bigint('total_marks', { mode: 'number' }).notNull().default(0),
    started_at: timestamp('started_at', { mode: 'date', precision: 0 }),
    submitted_at: timestamp('submitted_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'quiz_attempts_quiz_id_foreign',
      columns: [t.quiz_id],
      foreignColumns: [quizzes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'quiz_attempts_student_id_foreign',
      columns: [t.student_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('quiz_attempts_quiz_id_index').on(t.quiz_id),
    index('quiz_attempts_student_id_index').on(t.student_id),
    // Not in legacy: the super admin's per-day counts (SuperService.dashboard, aiUsage).
    index('quiz_attempts_submitted_at_index').on(t.submitted_at),
  ],
);

export const quizzes = pgTable(
  'quizzes',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    school_id: bigint('school_id', { mode: 'bigint' }),
    subject_id: bigint('subject_id', { mode: 'bigint' }),
    chapter_id: bigint('chapter_id', { mode: 'bigint' }),
    created_by: bigint('created_by', { mode: 'bigint' }),
    title: citext('title').notNull(),
    description: text('description'),
    duration_min: bigint('duration_min', { mode: 'number' })
      .notNull()
      .default(15),
    total_marks: bigint('total_marks', { mode: 'number' }).notNull().default(0),
    pass_marks: bigint('pass_marks', { mode: 'number' }).notNull().default(0),
    shuffle_questions: boolean('shuffle_questions').notNull().default(true),
    is_published: boolean('is_published').notNull().default(false),
    starts_at: timestamp('starts_at', { mode: 'date', precision: 0 }),
    ends_at: timestamp('ends_at', { mode: 'date', precision: 0 }),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'quizzes_chapter_id_foreign',
      columns: [t.chapter_id],
      foreignColumns: [chapters.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'quizzes_created_by_foreign',
      columns: [t.created_by],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'quizzes_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'quizzes_subject_id_foreign',
      columns: [t.subject_id],
      foreignColumns: [subjects.id],
    }).onDelete('set null'),
    index('quizzes_chapter_id_index').on(t.chapter_id),
    index('quizzes_created_by_index').on(t.created_by),
    index('quizzes_school_id_index').on(t.school_id),
    index('quizzes_subject_id_index').on(t.subject_id),
  ],
);

export const school_syllabus = pgTable(
  'school_syllabus',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    school_id: bigint('school_id', { mode: 'bigint' }).notNull(),
    syllabus_id: bigint('syllabus_id', { mode: 'bigint' }).notNull(),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'school_syllabus_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'school_syllabus_syllabus_id_foreign',
      columns: [t.syllabus_id],
      foreignColumns: [syllabi.id],
    }).onDelete('cascade'),
    uniqueIndex('school_syllabus_school_id_syllabus_id_unique').on(
      t.school_id,
      t.syllabus_id,
    ),
    index('school_syllabus_syllabus_id_index').on(t.syllabus_id),
  ],
);

export const schools = pgTable(
  'schools',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    name: citext('name').notNull(),
    slug: citext('slug').notNull(),
    code: citext('code').notNull(),
    email: citext('email'),
    phone: citext('phone'),
    logo: citext('logo'),
    address: text('address'),
    city: citext('city'),
    state: citext('state'),
    country: citext('country').notNull().default('India'),
    plan: citext('plan').notNull().default('free'),
    max_teachers: bigint('max_teachers', { mode: 'number' })
      .notNull()
      .default(10),
    max_students: bigint('max_students', { mode: 'number' })
      .notNull()
      .default(500),
    ai_daily_token_limit: bigint('ai_daily_token_limit', { mode: 'number' })
      .notNull()
      .default(5000),
    plan_expires_at: date('plan_expires_at', { mode: 'date' }),
    status: citext('status').notNull().default('active'),
    settings: text('settings'),
    // not in legacy: the default organization of self sign-up students
    // ("Bodhira Direct", run by the Super Admin). See common/organization.ts.
    is_direct: boolean('is_direct').notNull().default(false),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
    deleted_at: timestamp('deleted_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    uniqueIndex('schools_slug_unique').on(t.slug),
    uniqueIndex('schools_code_unique').on(t.code),
    index('schools_status_index').on(t.status),
    // At most one direct organization.
    uniqueIndex('schools_is_direct_unique')
      .on(t.is_direct)
      .where(sql`${t.is_direct}`),
  ],
);

export const services = pgTable(
  'services',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    icon: citext('icon'),
    title: citext('title').notNull(),
    slug: citext('slug').notNull(),
    excerpt: citext('excerpt'),
    body: text('body'),
    image_url: citext('image_url'),
    sort_order: integer('sort_order').notNull().default(0),
    is_featured: boolean('is_featured').notNull().default(false),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
    deleted_at: timestamp('deleted_at', { mode: 'date', precision: 0 }),
  },
  (t) => [uniqueIndex('services_slug_unique').on(t.slug)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: citext('id').primaryKey(),
    user_id: bigint('user_id', { mode: 'bigint' }),
    ip_address: citext('ip_address'),
    user_agent: text('user_agent'),
    payload: text('payload').notNull(),
    last_activity: integer('last_activity').notNull(),
  },
  (t) => [
    index('sessions_last_activity_index').on(t.last_activity),
    index('sessions_user_id_index').on(t.user_id),
  ],
);

export const site_settings = pgTable(
  'site_settings',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    group: citext('group').notNull(),
    key: citext('key').notNull(),
    value: text('value'),
    type: citext('type').notNull().default('text'),
    label: citext('label'),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    uniqueIndex('site_settings_group_key_unique').on(t.group, t.key),
    index('site_settings_group_index').on(t.group),
  ],
);

export const social_links = pgTable('social_links', {
  id: bigint('id', { mode: 'bigint' })
    .primaryKey()
    .generatedByDefaultAsIdentity(),
  platform: citext('platform').notNull(),
  label: citext('label'),
  url: citext('url').notNull(),
  icon: citext('icon'),
  sort_order: integer('sort_order').notNull().default(0),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
  updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
});

export const student_enquiries = pgTable(
  'student_enquiries',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    name: citext('name').notNull(),
    email: citext('email').notNull(),
    phone: citext('phone').notNull(),
    grade: citext('grade'),
    board: citext('board'),
    city: citext('city'),
    school_name: citext('school_name'),
    message: text('message'),
    status: citext('status').notNull().default('new'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [index('student_enquiries_status_index').on(t.status)],
);

export const subjects = pgTable(
  'subjects',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    school_id: bigint('school_id', { mode: 'bigint' }),
    syllabus_id: bigint('syllabus_id', { mode: 'bigint' }),
    name: citext('name').notNull(),
    slug: citext('slug').notNull(),
    grade: citext('grade'),
    icon: citext('icon'),
    color: citext('color'),
    description: text('description'),
    sort_order: bigint('sort_order', { mode: 'number' }).notNull().default(0),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'subjects_school_id_foreign',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'subjects_syllabus_id_foreign',
      columns: [t.syllabus_id],
      foreignColumns: [syllabi.id],
    }).onDelete('set null'),
    uniqueIndex('subjects_school_id_slug_grade_unique').on(
      t.school_id,
      t.slug,
      t.grade,
    ),
    index('subjects_grade_index').on(t.grade),
    index('subjects_syllabus_id_index').on(t.syllabus_id),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    subscribable_type: citext('subscribable_type').notNull(),
    subscribable_id: bigint('subscribable_id', { mode: 'bigint' }).notNull(),
    plan: citext('plan').notNull(),
    status: citext('status').notNull().default('trialing'),
    trial_ends_at: timestamp('trial_ends_at', { mode: 'date', precision: 0 }),
    current_period_start: date('current_period_start', { mode: 'date' }),
    current_period_end: date('current_period_end', { mode: 'date' }),
    source_payment_id: bigint('source_payment_id', { mode: 'bigint' }),
    meta: text('meta'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    foreignKey({
      name: 'subscriptions_source_payment_id_foreign',
      columns: [t.source_payment_id],
      foreignColumns: [payments.id],
    }).onDelete('set null'),
    index('subscribable_idx').on(t.subscribable_type, t.subscribable_id),
    index('subscriptions_source_payment_id_index').on(t.source_payment_id),
    index('subscriptions_status_index').on(t.status),
  ],
);

export const syllabi = pgTable(
  'syllabi',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    board: citext('board').notNull(),
    grade: citext('grade').notNull(),
    name: citext('name').notNull(),
    slug: citext('slug').notNull(),
    description: text('description'),
    sort_order: bigint('sort_order', { mode: 'number' }).notNull().default(0),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    uniqueIndex('syllabi_slug_unique').on(t.slug),
    uniqueIndex('syllabi_board_grade_unique').on(t.board, t.grade),
    index('syllabi_board_index').on(t.board),
    index('syllabi_grade_index').on(t.grade),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    name: citext('name').notNull(),
    slug: citext('slug').notNull(),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [uniqueIndex('tags_slug_unique').on(t.slug)],
);

export const team_members = pgTable('team_members', {
  id: bigint('id', { mode: 'bigint' })
    .primaryKey()
    .generatedByDefaultAsIdentity(),
  name: citext('name').notNull(),
  role: citext('role'),
  photo_url: citext('photo_url'),
  bio: text('bio'),
  socials: text('socials'),
  sort_order: integer('sort_order').notNull().default(0),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
  updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  deleted_at: timestamp('deleted_at', { mode: 'date', precision: 0 }),
});

export const testimonials = pgTable('testimonials', {
  id: bigint('id', { mode: 'bigint' })
    .primaryKey()
    .generatedByDefaultAsIdentity(),
  name: citext('name').notNull(),
  role: citext('role'),
  company: citext('company'),
  avatar_url: citext('avatar_url'),
  quote: text('quote').notNull(),
  rating: smallint('rating').notNull().default(5),
  sort_order: integer('sort_order').notNull().default(0),
  is_featured: boolean('is_featured').notNull().default(false),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
  updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  deleted_at: timestamp('deleted_at', { mode: 'date', precision: 0 }),
});

export const users = pgTable(
  'users',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    school_id: bigint('school_id', { mode: 'bigint' }),
    syllabus_id: bigint('syllabus_id', { mode: 'bigint' }),
    name: citext('name').notNull(),
    email: citext('email'),
    phone: citext('phone'),
    username: citext('username'),
    email_verified_at: timestamp('email_verified_at', {
      mode: 'date',
      precision: 0,
    }),
    phone_verified_at: timestamp('phone_verified_at', {
      mode: 'date',
      precision: 0,
    }),
    password: citext('password'),
    role: citext('role').notNull().default('student'),
    avatar: citext('avatar'),
    dob: date('dob', { mode: 'date' }),
    gender: citext('gender'),
    grade: citext('grade'),
    locale: citext('locale').notNull().default('en'),
    status: citext('status').notNull().default('active'),
    otp: citext('otp'),
    otp_expires_at: timestamp('otp_expires_at', { mode: 'date', precision: 0 }),
    last_login_at: timestamp('last_login_at', { mode: 'date', precision: 0 }),
    remember_token: citext('remember_token'),
    created_at: timestamp('created_at', { mode: 'date', precision: 0 }),
    updated_at: timestamp('updated_at', { mode: 'date', precision: 0 }),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_phone_unique').on(t.phone),
    uniqueIndex('users_username_unique').on(t.username),
    foreignKey({
      name: '1',
      columns: [t.school_id],
      foreignColumns: [schools.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'users_syllabus_id_foreign',
      columns: [t.syllabus_id],
      foreignColumns: [syllabi.id],
    }).onDelete('set null'),
    index('1_index').on(t.school_id),
    index('users_role_index').on(t.role),
    index('users_status_index').on(t.status),
    index('users_syllabus_id_index').on(t.syllabus_id),
    // Not in legacy: sign-up counts on the super admin dashboard.
    index('users_created_at_index').on(t.created_at),
  ],
);

export const achievementsRelations = relations(
  achievements,
  ({ one, many }) => ({
    users: one(users, {
      fields: [achievements.student_id],
      references: [users.id],
      relationName: 'achievements_users_student_id',
    }),
  }),
);

export const ai_chat_messagesRelations = relations(
  ai_chat_messages,
  ({ one, many }) => ({
    ai_chat_sessions: one(ai_chat_sessions, {
      fields: [ai_chat_messages.session_id],
      references: [ai_chat_sessions.id],
      relationName: 'ai_chat_messages_ai_chat_sessions_session_id',
    }),
  }),
);

export const ai_chat_sessionsRelations = relations(
  ai_chat_sessions,
  ({ one, many }) => ({
    ai_chat_messages: many(ai_chat_messages, {
      relationName: 'ai_chat_messages_ai_chat_sessions_session_id',
    }),
    users: one(users, {
      fields: [ai_chat_sessions.user_id],
      references: [users.id],
      relationName: 'ai_chat_sessions_users_user_id',
    }),
  }),
);

export const announcementsRelations = relations(
  announcements,
  ({ one, many }) => ({
    classes: one(classes, {
      fields: [announcements.class_id],
      references: [classes.id],
      relationName: 'announcements_classes_class_id',
    }),
    users: one(users, {
      fields: [announcements.created_by],
      references: [users.id],
      relationName: 'announcements_users_created_by',
    }),
    schools: one(schools, {
      fields: [announcements.school_id],
      references: [schools.id],
      relationName: 'announcements_schools_school_id',
    }),
  }),
);

export const assignment_submissionsRelations = relations(
  assignment_submissions,
  ({ one, many }) => ({
    assignments: one(assignments, {
      fields: [assignment_submissions.assignment_id],
      references: [assignments.id],
      relationName: 'assignment_submissions_assignments_assignment_id',
    }),
    users_assignment_submissions_graded_byTousers: one(users, {
      fields: [assignment_submissions.graded_by],
      references: [users.id],
      relationName: 'assignment_submissions_graded_byTousers',
    }),
    users_assignment_submissions_student_idTousers: one(users, {
      fields: [assignment_submissions.student_id],
      references: [users.id],
      relationName: 'assignment_submissions_student_idTousers',
    }),
  }),
);

export const assignmentsRelations = relations(assignments, ({ one, many }) => ({
  assignment_submissions: many(assignment_submissions, {
    relationName: 'assignment_submissions_assignments_assignment_id',
  }),
  classes: one(classes, {
    fields: [assignments.class_id],
    references: [classes.id],
    relationName: 'assignments_classes_class_id',
  }),
  subjects: one(subjects, {
    fields: [assignments.subject_id],
    references: [subjects.id],
    relationName: 'assignments_subjects_subject_id',
  }),
  users: one(users, {
    fields: [assignments.teacher_id],
    references: [users.id],
    relationName: 'assignments_users_teacher_id',
  }),
}));

export const attendanceRelations = relations(attendance, ({ one, many }) => ({
  classes: one(classes, {
    fields: [attendance.class_id],
    references: [classes.id],
    relationName: 'attendance_classes_class_id',
  }),
  users_attendance_marked_byTousers: one(users, {
    fields: [attendance.marked_by],
    references: [users.id],
    relationName: 'attendance_marked_byTousers',
  }),
  users_attendance_student_idTousers: one(users, {
    fields: [attendance.student_id],
    references: [users.id],
    relationName: 'attendance_student_idTousers',
  }),
}));

export const audit_logsRelations = relations(audit_logs, ({ one, many }) => ({
  schools: one(schools, {
    fields: [audit_logs.school_id],
    references: [schools.id],
    relationName: 'audit_logs_schools_school_id',
  }),
  users: one(users, {
    fields: [audit_logs.user_id],
    references: [users.id],
    relationName: 'audit_logs_users_user_id',
  }),
}));

export const blog_categoriesRelations = relations(
  blog_categories,
  ({ one, many }) => ({
    blog_posts: many(blog_posts, {
      relationName: 'blog_posts_blog_categories_blog_category_id',
    }),
  }),
);

export const blog_post_tagRelations = relations(
  blog_post_tag,
  ({ one, many }) => ({
    blog_posts: one(blog_posts, {
      fields: [blog_post_tag.blog_post_id],
      references: [blog_posts.id],
      relationName: 'blog_post_tag_blog_posts_blog_post_id',
    }),
    tags: one(tags, {
      fields: [blog_post_tag.tag_id],
      references: [tags.id],
      relationName: 'blog_post_tag_tags_tag_id',
    }),
  }),
);

export const blog_postsRelations = relations(blog_posts, ({ one, many }) => ({
  blog_post_tag: many(blog_post_tag, {
    relationName: 'blog_post_tag_blog_posts_blog_post_id',
  }),
  users: one(users, {
    fields: [blog_posts.author_id],
    references: [users.id],
    relationName: 'blog_posts_users_author_id',
  }),
  blog_categories: one(blog_categories, {
    fields: [blog_posts.blog_category_id],
    references: [blog_categories.id],
    relationName: 'blog_posts_blog_categories_blog_category_id',
  }),
}));

export const chaptersRelations = relations(chapters, ({ one, many }) => ({
  subjects: one(subjects, {
    fields: [chapters.subject_id],
    references: [subjects.id],
    relationName: 'chapters_subjects_subject_id',
  }),
  lessons: many(lessons, { relationName: 'lessons_chapters_chapter_id' }),
  quizzes: many(quizzes, { relationName: 'quizzes_chapters_chapter_id' }),
}));

export const class_studentRelations = relations(
  class_student,
  ({ one, many }) => ({
    classes: one(classes, {
      fields: [class_student.class_id],
      references: [classes.id],
      relationName: 'class_student_classes_class_id',
    }),
    users: one(users, {
      fields: [class_student.student_id],
      references: [users.id],
      relationName: 'class_student_users_student_id',
    }),
  }),
);

export const class_subjectRelations = relations(
  class_subject,
  ({ one, many }) => ({
    classes: one(classes, {
      fields: [class_subject.class_id],
      references: [classes.id],
      relationName: 'class_subject_classes_class_id',
    }),
    subjects: one(subjects, {
      fields: [class_subject.subject_id],
      references: [subjects.id],
      relationName: 'class_subject_subjects_subject_id',
    }),
    users: one(users, {
      fields: [class_subject.teacher_id],
      references: [users.id],
      relationName: 'class_subject_users_teacher_id',
    }),
  }),
);

export const classesRelations = relations(classes, ({ one, many }) => ({
  announcements: many(announcements, {
    relationName: 'announcements_classes_class_id',
  }),
  assignments: many(assignments, {
    relationName: 'assignments_classes_class_id',
  }),
  attendance: many(attendance, { relationName: 'attendance_classes_class_id' }),
  class_student: many(class_student, {
    relationName: 'class_student_classes_class_id',
  }),
  class_subject: many(class_subject, {
    relationName: 'class_subject_classes_class_id',
  }),
  users: one(users, {
    fields: [classes.class_teacher_id],
    references: [users.id],
    relationName: 'classes_users_class_teacher_id',
  }),
  schools: one(schools, {
    fields: [classes.school_id],
    references: [schools.id],
    relationName: 'classes_schools_school_id',
  }),
  live_classes: many(live_classes, {
    relationName: 'live_classes_classes_class_id',
  }),
}));

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    users_conversations_user_one_idTousers: one(users, {
      fields: [conversations.user_one_id],
      references: [users.id],
      relationName: 'conversations_user_one_idTousers',
    }),
    users_conversations_user_two_idTousers: one(users, {
      fields: [conversations.user_two_id],
      references: [users.id],
      relationName: 'conversations_user_two_idTousers',
    }),
    messages: many(messages, {
      relationName: 'messages_conversations_conversation_id',
    }),
  }),
);

export const discussionsRelations = relations(discussions, ({ one, many }) => ({
  lessons: one(lessons, {
    fields: [discussions.lesson_id],
    references: [lessons.id],
    relationName: 'discussions_lessons_lesson_id',
  }),
  discussions: one(discussions, {
    fields: [discussions.parent_id],
    references: [discussions.id],
    relationName: 'discussionsTodiscussions',
  }),
  other_discussions: many(discussions, {
    relationName: 'discussionsTodiscussions',
  }),
  users: one(users, {
    fields: [discussions.user_id],
    references: [users.id],
    relationName: 'discussions_users_user_id',
  }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  payments: one(payments, {
    fields: [invoices.payment_id],
    references: [payments.id],
    relationName: 'invoices_payments_payment_id',
  }),
  schools: one(schools, {
    fields: [invoices.school_id],
    references: [schools.id],
    relationName: 'invoices_schools_school_id',
  }),
  subscriptions: one(subscriptions, {
    fields: [invoices.subscription_id],
    references: [subscriptions.id],
    relationName: 'invoices_subscriptions_subscription_id',
  }),
  users: one(users, {
    fields: [invoices.user_id],
    references: [users.id],
    relationName: 'invoices_users_user_id',
  }),
}));

export const lesson_progressRelations = relations(
  lesson_progress,
  ({ one, many }) => ({
    lessons: one(lessons, {
      fields: [lesson_progress.lesson_id],
      references: [lessons.id],
      relationName: 'lesson_progress_lessons_lesson_id',
    }),
    users: one(users, {
      fields: [lesson_progress.student_id],
      references: [users.id],
      relationName: 'lesson_progress_users_student_id',
    }),
  }),
);

export const lessonsRelations = relations(lessons, ({ one, many }) => ({
  discussions: many(discussions, {
    relationName: 'discussions_lessons_lesson_id',
  }),
  lesson_progress: many(lesson_progress, {
    relationName: 'lesson_progress_lessons_lesson_id',
  }),
  chapters: one(chapters, {
    fields: [lessons.chapter_id],
    references: [chapters.id],
    relationName: 'lessons_chapters_chapter_id',
  }),
}));

export const live_class_attendeesRelations = relations(
  live_class_attendees,
  ({ one, many }) => ({
    live_classes: one(live_classes, {
      fields: [live_class_attendees.live_class_id],
      references: [live_classes.id],
      relationName: 'live_class_attendees_live_classes_live_class_id',
    }),
    users: one(users, {
      fields: [live_class_attendees.user_id],
      references: [users.id],
      relationName: 'live_class_attendees_users_user_id',
    }),
  }),
);

export const live_classesRelations = relations(
  live_classes,
  ({ one, many }) => ({
    live_class_attendees: many(live_class_attendees, {
      relationName: 'live_class_attendees_live_classes_live_class_id',
    }),
    classes: one(classes, {
      fields: [live_classes.class_id],
      references: [classes.id],
      relationName: 'live_classes_classes_class_id',
    }),
    users: one(users, {
      fields: [live_classes.host_id],
      references: [users.id],
      relationName: 'live_classes_users_host_id',
    }),
    schools: one(schools, {
      fields: [live_classes.school_id],
      references: [schools.id],
      relationName: 'live_classes_schools_school_id',
    }),
    subjects: one(subjects, {
      fields: [live_classes.subject_id],
      references: [subjects.id],
      relationName: 'live_classes_subjects_subject_id',
    }),
    syllabi: one(syllabi, {
      fields: [live_classes.syllabus_id],
      references: [syllabi.id],
      relationName: 'live_classes_syllabi_syllabus_id',
    }),
  }),
);

export const mediaRelations = relations(media, ({ one, many }) => ({
  media_folders: one(media_folders, {
    fields: [media.media_folder_id],
    references: [media_folders.id],
    relationName: 'media_media_folders_media_folder_id',
  }),
}));

export const media_foldersRelations = relations(
  media_folders,
  ({ one, many }) => ({
    media: many(media, { relationName: 'media_media_folders_media_folder_id' }),
    media_folders: one(media_folders, {
      fields: [media_folders.parent_id],
      references: [media_folders.id],
      relationName: 'media_foldersTomedia_folders',
    }),
    other_media_folders: many(media_folders, {
      relationName: 'media_foldersTomedia_folders',
    }),
  }),
);

export const menu_itemsRelations = relations(menu_items, ({ one, many }) => ({
  navigation_menus: one(navigation_menus, {
    fields: [menu_items.navigation_menu_id],
    references: [navigation_menus.id],
    relationName: 'menu_items_navigation_menus_navigation_menu_id',
  }),
  menu_items: one(menu_items, {
    fields: [menu_items.parent_id],
    references: [menu_items.id],
    relationName: 'menu_itemsTomenu_items',
  }),
  other_menu_items: many(menu_items, {
    relationName: 'menu_itemsTomenu_items',
  }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversations: one(conversations, {
    fields: [messages.conversation_id],
    references: [conversations.id],
    relationName: 'messages_conversations_conversation_id',
  }),
  users: one(users, {
    fields: [messages.sender_id],
    references: [users.id],
    relationName: 'messages_users_sender_id',
  }),
}));

export const navigation_menusRelations = relations(
  navigation_menus,
  ({ one, many }) => ({
    menu_items: many(menu_items, {
      relationName: 'menu_items_navigation_menus_navigation_menu_id',
    }),
  }),
);

export const page_sectionsRelations = relations(
  page_sections,
  ({ one, many }) => ({
    pages: one(pages, {
      fields: [page_sections.page_id],
      references: [pages.id],
      relationName: 'page_sections_pages_page_id',
    }),
  }),
);

export const pagesRelations = relations(pages, ({ one, many }) => ({
  page_sections: many(page_sections, {
    relationName: 'page_sections_pages_page_id',
  }),
}));

export const parent_studentRelations = relations(
  parent_student,
  ({ one, many }) => ({
    users_parent_student_parent_idTousers: one(users, {
      fields: [parent_student.parent_id],
      references: [users.id],
      relationName: 'parent_student_parent_idTousers',
    }),
    users_parent_student_student_idTousers: one(users, {
      fields: [parent_student.student_id],
      references: [users.id],
      relationName: 'parent_student_student_idTousers',
    }),
  }),
);

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  invoices: many(invoices, { relationName: 'invoices_payments_payment_id' }),
  schools: one(schools, {
    fields: [payments.school_id],
    references: [schools.id],
    relationName: 'payments_schools_school_id',
  }),
  subscriptions: many(subscriptions, {
    relationName: 'subscriptions_payments_source_payment_id',
  }),
}));

export const questionsRelations = relations(questions, ({ one, many }) => ({
  quizzes: one(quizzes, {
    fields: [questions.quiz_id],
    references: [quizzes.id],
    relationName: 'questions_quizzes_quiz_id',
  }),
  quiz_answers: many(quiz_answers, {
    relationName: 'quiz_answers_questions_question_id',
  }),
}));

export const quiz_answersRelations = relations(
  quiz_answers,
  ({ one, many }) => ({
    quiz_attempts: one(quiz_attempts, {
      fields: [quiz_answers.attempt_id],
      references: [quiz_attempts.id],
      relationName: 'quiz_answers_quiz_attempts_attempt_id',
    }),
    questions: one(questions, {
      fields: [quiz_answers.question_id],
      references: [questions.id],
      relationName: 'quiz_answers_questions_question_id',
    }),
  }),
);

export const quiz_attemptsRelations = relations(
  quiz_attempts,
  ({ one, many }) => ({
    quiz_answers: many(quiz_answers, {
      relationName: 'quiz_answers_quiz_attempts_attempt_id',
    }),
    quizzes: one(quizzes, {
      fields: [quiz_attempts.quiz_id],
      references: [quizzes.id],
      relationName: 'quiz_attempts_quizzes_quiz_id',
    }),
    users: one(users, {
      fields: [quiz_attempts.student_id],
      references: [users.id],
      relationName: 'quiz_attempts_users_student_id',
    }),
  }),
);

export const quizzesRelations = relations(quizzes, ({ one, many }) => ({
  questions: many(questions, { relationName: 'questions_quizzes_quiz_id' }),
  quiz_attempts: many(quiz_attempts, {
    relationName: 'quiz_attempts_quizzes_quiz_id',
  }),
  chapters: one(chapters, {
    fields: [quizzes.chapter_id],
    references: [chapters.id],
    relationName: 'quizzes_chapters_chapter_id',
  }),
  users: one(users, {
    fields: [quizzes.created_by],
    references: [users.id],
    relationName: 'quizzes_users_created_by',
  }),
  schools: one(schools, {
    fields: [quizzes.school_id],
    references: [schools.id],
    relationName: 'quizzes_schools_school_id',
  }),
  subjects: one(subjects, {
    fields: [quizzes.subject_id],
    references: [subjects.id],
    relationName: 'quizzes_subjects_subject_id',
  }),
}));

export const school_syllabusRelations = relations(
  school_syllabus,
  ({ one, many }) => ({
    schools: one(schools, {
      fields: [school_syllabus.school_id],
      references: [schools.id],
      relationName: 'school_syllabus_schools_school_id',
    }),
    syllabi: one(syllabi, {
      fields: [school_syllabus.syllabus_id],
      references: [syllabi.id],
      relationName: 'school_syllabus_syllabi_syllabus_id',
    }),
  }),
);

export const schoolsRelations = relations(schools, ({ one, many }) => ({
  announcements: many(announcements, {
    relationName: 'announcements_schools_school_id',
  }),
  audit_logs: many(audit_logs, {
    relationName: 'audit_logs_schools_school_id',
  }),
  classes: many(classes, { relationName: 'classes_schools_school_id' }),
  invoices: many(invoices, { relationName: 'invoices_schools_school_id' }),
  live_classes: many(live_classes, {
    relationName: 'live_classes_schools_school_id',
  }),
  payments: many(payments, { relationName: 'payments_schools_school_id' }),
  quizzes: many(quizzes, { relationName: 'quizzes_schools_school_id' }),
  school_syllabus: many(school_syllabus, {
    relationName: 'school_syllabus_schools_school_id',
  }),
  subjects: many(subjects, { relationName: 'subjects_schools_school_id' }),
  users: many(users, { relationName: 'users_schools_school_id' }),
}));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
  assignments: many(assignments, {
    relationName: 'assignments_subjects_subject_id',
  }),
  chapters: many(chapters, { relationName: 'chapters_subjects_subject_id' }),
  class_subject: many(class_subject, {
    relationName: 'class_subject_subjects_subject_id',
  }),
  live_classes: many(live_classes, {
    relationName: 'live_classes_subjects_subject_id',
  }),
  quizzes: many(quizzes, { relationName: 'quizzes_subjects_subject_id' }),
  schools: one(schools, {
    fields: [subjects.school_id],
    references: [schools.id],
    relationName: 'subjects_schools_school_id',
  }),
  syllabi: one(syllabi, {
    fields: [subjects.syllabus_id],
    references: [syllabi.id],
    relationName: 'subjects_syllabi_syllabus_id',
  }),
}));

export const subscriptionsRelations = relations(
  subscriptions,
  ({ one, many }) => ({
    invoices: many(invoices, {
      relationName: 'invoices_subscriptions_subscription_id',
    }),
    payments: one(payments, {
      fields: [subscriptions.source_payment_id],
      references: [payments.id],
      relationName: 'subscriptions_payments_source_payment_id',
    }),
  }),
);

export const syllabiRelations = relations(syllabi, ({ one, many }) => ({
  live_classes: many(live_classes, {
    relationName: 'live_classes_syllabi_syllabus_id',
  }),
  school_syllabus: many(school_syllabus, {
    relationName: 'school_syllabus_syllabi_syllabus_id',
  }),
  subjects: many(subjects, { relationName: 'subjects_syllabi_syllabus_id' }),
  users: many(users, { relationName: 'users_syllabi_syllabus_id' }),
}));

export const tagsRelations = relations(tags, ({ one, many }) => ({
  blog_post_tag: many(blog_post_tag, {
    relationName: 'blog_post_tag_tags_tag_id',
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  achievements: many(achievements, {
    relationName: 'achievements_users_student_id',
  }),
  ai_chat_sessions: many(ai_chat_sessions, {
    relationName: 'ai_chat_sessions_users_user_id',
  }),
  announcements: many(announcements, {
    relationName: 'announcements_users_created_by',
  }),
  assignment_submissions_assignment_submissions_graded_byTousers: many(
    assignment_submissions,
    { relationName: 'assignment_submissions_graded_byTousers' },
  ),
  assignment_submissions_assignment_submissions_student_idTousers: many(
    assignment_submissions,
    { relationName: 'assignment_submissions_student_idTousers' },
  ),
  assignments: many(assignments, {
    relationName: 'assignments_users_teacher_id',
  }),
  attendance_attendance_marked_byTousers: many(attendance, {
    relationName: 'attendance_marked_byTousers',
  }),
  attendance_attendance_student_idTousers: many(attendance, {
    relationName: 'attendance_student_idTousers',
  }),
  audit_logs: many(audit_logs, { relationName: 'audit_logs_users_user_id' }),
  blog_posts: many(blog_posts, { relationName: 'blog_posts_users_author_id' }),
  class_student: many(class_student, {
    relationName: 'class_student_users_student_id',
  }),
  class_subject: many(class_subject, {
    relationName: 'class_subject_users_teacher_id',
  }),
  classes: many(classes, { relationName: 'classes_users_class_teacher_id' }),
  conversations_conversations_user_one_idTousers: many(conversations, {
    relationName: 'conversations_user_one_idTousers',
  }),
  conversations_conversations_user_two_idTousers: many(conversations, {
    relationName: 'conversations_user_two_idTousers',
  }),
  discussions: many(discussions, { relationName: 'discussions_users_user_id' }),
  invoices: many(invoices, { relationName: 'invoices_users_user_id' }),
  lesson_progress: many(lesson_progress, {
    relationName: 'lesson_progress_users_student_id',
  }),
  live_class_attendees: many(live_class_attendees, {
    relationName: 'live_class_attendees_users_user_id',
  }),
  live_classes: many(live_classes, {
    relationName: 'live_classes_users_host_id',
  }),
  messages: many(messages, { relationName: 'messages_users_sender_id' }),
  parent_student_parent_student_parent_idTousers: many(parent_student, {
    relationName: 'parent_student_parent_idTousers',
  }),
  parent_student_parent_student_student_idTousers: many(parent_student, {
    relationName: 'parent_student_student_idTousers',
  }),
  quiz_attempts: many(quiz_attempts, {
    relationName: 'quiz_attempts_users_student_id',
  }),
  quizzes: many(quizzes, { relationName: 'quizzes_users_created_by' }),
  schools: one(schools, {
    fields: [users.school_id],
    references: [schools.id],
    relationName: 'users_schools_school_id',
  }),
  syllabi: one(syllabi, {
    fields: [users.syllabus_id],
    references: [syllabi.id],
    relationName: 'users_syllabi_syllabus_id',
  }),
}));

// not in legacy: single-use codes that hand a mobile app's session to the web
// (POST /auth/web-handoff).
export const web_handoff_codes = pgTable(
  'web_handoff_codes',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
    /** sha256 (hex) of the code; the code itself is never stored. */
    code_hash: text('code_hash').notNull(),
    /** Relative web path to open after sign-in. */
    next: text('next').notNull(),
    expires_at: timestamp('expires_at', {
      mode: 'date',
      precision: 3,
    }).notNull(),
    used_at: timestamp('used_at', { mode: 'date', precision: 3 }),
    created_at: timestamp('created_at', {
      mode: 'date',
      precision: 3,
    }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'web_handoff_codes_user_id_foreign',
      columns: [t.user_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('web_handoff_codes_code_hash_unique').on(t.code_hash),
    index('web_handoff_codes_expires_at_index').on(t.expires_at),
  ],
);

// security: not in legacy: wrong-code counter for the OTP currently issued to a
// user (POST /auth/otp/verify). Five wrong codes invalidate the OTP.
export const otp_attempts = pgTable(
  'otp_attempts',
  {
    user_id: bigint('user_id', { mode: 'bigint' }).primaryKey(),
    attempts: integer('attempts').notNull().default(0),
    updated_at: timestamp('updated_at', {
      mode: 'date',
      precision: 3,
    }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'otp_attempts_user_id_foreign',
      columns: [t.user_id],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
  ],
);

// not in legacy: the platform's outgoing-mail (SMTP) settings, edited in the super
// admin panel (/super/mail-settings). A single row (id 1). `password_enc` is the
// SMTP password encrypted with AES-256-GCM (`mail/mail-crypto.ts`); it is never
// returned by the API.
export const mail_settings = pgTable('mail_settings', {
  id: smallint('id').primaryKey(),
  /** `smtp` or `log`. */
  mailer: citext('mailer').notNull(),
  host: citext('host'),
  port: integer('port'),
  /** `tls` (STARTTLS), `ssl` (implicit TLS) or `none`. */
  encryption: citext('encryption'),
  username: citext('username'),
  password_enc: text('password_enc'),
  from_address: citext('from_address').notNull(),
  from_name: citext('from_name'),
  updated_by: bigint('updated_by', { mode: 'bigint' }),
  updated_at: timestamp('updated_at', { mode: 'date', precision: 3 }).notNull(),
});
