import { Inject, Injectable } from '@nestjs/common';
import { statfs } from 'node:fs/promises';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { dirtyFields, toModel } from '../common/http/eloquent';
import {
  iso8601,
  jsonCast,
  parseLaravelDate,
  phpJsonEncode,
} from '../common/http/laravel';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc, containsCi, countOf, myDesc, mySum } from '../db/helpers';
import {
  ai_chat_messages,
  ai_chat_sessions,
  attendance,
  classes,
  lesson_progress,
  quiz_attempts,
  school_syllabus,
  schools as schoolsTable,
  subjects,
  users as usersTable,
} from '../db/schema';
import type { schools } from '../db/types';
import { strRandom, strSlug } from '../storage/laravel-str';
import { StorageService } from '../storage/storage.service';
import type { IncomingFile } from '../storage/upload-rules';
import { themeFromImage } from './color-extractor';
import { dayAgo, monthDay, onDay } from '../admin/admin.service';

/** SuperAdminService::PLAN_PRICING: monthly per-school revenue assumption (₹). */
export const PLAN_PRICING: Record<string, number> = {
  free: 0,
  starter: 9999,
  pro: 24999,
  enterprise: 99999,
};

const int = (v: unknown) => Math.trunc(Number(v ?? 0)) || 0;

/** Soft-deleted schools are invisible to Eloquent queries. */
export const LIVE_SCHOOL = isNull(schoolsTable.deleted_at);

const pct = (n: number, total: number) =>
  total > 0 ? Math.round((n / total) * 100) : 0;

/** DATE value for a validated date string. */
const dateValue = (v: unknown) =>
  typeof v === 'string'
    ? new Date(
        `${parseLaravelDate(v)!.stored.toISOString().slice(0, 10)}T00:00:00Z`,
      )
    : null;

/**
 * `date_col <= / >= <datetime>` as legacy compared them: the DATE is taken as
 * midnight, not the datetime truncated to a date.
 */
const dateCmp = (
  col: typeof schoolsTable.plan_expires_at,
  op: '>=' | '<=',
  d: Date,
) => sql`${col} ${sql.raw(op)} ${d.toISOString()}::timestamp`;

/** Port of App\Services\SuperAdminService. */
@Injectable()
export class SuperService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async dashboard() {
    const users = (role: Role) =>
      this.db.$count(usersTable, eq(usersTable.role, role));
    const active = await this.db.query.schools.findMany({
      where: and(LIVE_SCHOOL, eq(schoolsTable.status, 'active')),
      orderBy: [asc(schoolsTable.id)],
    });
    const mrr = active.reduce((n, s) => n + (PLAN_PRICING[s.plan] ?? 0), 0);
    const since = (days: number) => new Date(Date.now() - days * 86_400_000);

    const growth = [];
    for (let i = 6; i >= 0; i--) {
      const date = dayAgo(i);
      growth.push({
        date: monthDay(date),
        users: await this.db.$count(
          usersTable,
          onDay(usersTable.created_at, date),
        ),
        attempts: await this.db.$count(
          quiz_attempts,
          onDay(quiz_attempts.submitted_at, date),
        ),
      });
    }

    const top = await this.db.query.schools.findMany({
      where: LIVE_SCHOOL,
      orderBy: (t) => [desc(countOf(usersTable, 'school_id', t.id)), asc(t.id)],
      limit: 5,
      extras: (t) => ({
        users_count: countOf(usersTable, 'school_id', t.id).as('users_count'),
        classes_count: countOf(classes, 'school_id', t.id).as('classes_count'),
      }),
    });

    return {
      platform: {
        schools_total: await this.db.$count(schoolsTable, LIVE_SCHOOL),
        schools_active: active.length,
        users_total: await this.db.$count(usersTable),
        students: await users(Role.Student),
        teachers: await users(Role.Teacher),
        parents: await users(Role.Parent),
        classes: await this.db.$count(classes),
        mrr,
        arr_projection: mrr * 12,
        signups_7d: await this.db.$count(
          usersTable,
          gte(usersTable.created_at, since(7)),
        ),
        signups_30d: await this.db.$count(
          usersTable,
          gte(usersTable.created_at, since(30)),
        ),
        ai_sessions: await this.db.$count(ai_chat_sessions),
        ai_messages: await this.db.$count(ai_chat_messages),
        lesson_views: await this.db.$count(lesson_progress),
      },
      growth,
      top_schools: top.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        plan: s.plan,
        users_count: s.users_count,
        classes_count: s.classes_count,
        status: s.status,
      })),
    };
  }

  async paginatedSchools(
    q: string | null,
    status: string | null,
    plan: string | null,
    perPage: number,
    page: number,
  ) {
    const where = and(
      LIVE_SCHOOL,
      q
        ? or(
            containsCi(schoolsTable.name, q),
            containsCi(schoolsTable.code, q),
            containsCi(schoolsTable.email, q),
          )
        : undefined,
      status ? eq(schoolsTable.status, status) : undefined,
      plan ? eq(schoolsTable.plan, plan) : undefined,
    );
    const [items, total] = await Promise.all([
      this.db.query.schools.findMany({
        where,
        orderBy: [asc(schoolsTable.name), asc(schoolsTable.id)],
        offset: (page - 1) * perPage,
        limit: perPage,
        extras: (t) => ({
          users_count: countOf(usersTable, 'school_id', t.id).as('users_count'),
          classes_count: countOf(classes, 'school_id', t.id).as(
            'classes_count',
          ),
        }),
      }),
      this.db.$count(schoolsTable, where),
    ]);
    return { items, total };
  }

  async schoolDetail(school: schools) {
    const counts = {
      users: await this.db.$count(
        usersTable,
        eq(usersTable.school_id, school.id),
      ),
      classes: await this.db.$count(classes, eq(classes.school_id, school.id)),
      subjects: await this.db.$count(
        subjects,
        eq(subjects.school_id, school.id),
      ),
    };
    const count = (role: Role) =>
      this.db.$count(
        usersTable,
        and(eq(usersTable.school_id, school.id), eq(usersTable.role, role)),
      );
    // The school's students as a subquery, and the sums done by the database (this
    // loaded every submitted attempt of the school to average them in JS).
    const studentIds = this.db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.school_id, school.id),
          eq(usersTable.role, Role.Student),
        ),
      );
    const [att] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        present: sql<number>`(count(*) filter (where ${attendance.status} = 'present'))::int`,
      })
      .from(attendance)
      .where(inArray(attendance.student_id, studentIds));
    const { total, present } = att;
    // The same float8 operations summed in attempt-id order as the JS reduce did,
    // so the rounded average is identical.
    const [quiz] = await this.db
      .select({
        sum: sql<number>`sum(case when ${quiz_attempts.total_marks} > 0 then (${quiz_attempts.score}::float8 / ${quiz_attempts.total_marks}) * 100 else 0 end order by ${quiz_attempts.id})`,
        n: sql<number>`count(*)::int`,
      })
      .from(quiz_attempts)
      .where(
        and(
          inArray(quiz_attempts.student_id, studentIds),
          eq(quiz_attempts.status, 'submitted'),
        ),
      );
    const avg = quiz.n ? Math.round(Number(quiz.sum) / quiz.n) : 0;
    const admins = await this.db.query.users.findMany({
      where: and(
        eq(usersTable.school_id, school.id),
        eq(usersTable.role, Role.Admin),
      ),
      orderBy: [asc(usersTable.id)],
    });

    return {
      // loadCount() appends the counts after the columns.
      school: toModel('schools', school, {
        users_count: counts.users,
        classes_count: counts.classes,
        subjects_count: counts.subjects,
      }),
      stats: {
        students: await count(Role.Student),
        teachers: await count(Role.Teacher),
        parents: await count(Role.Parent),
        classes: counts.classes,
        subjects: counts.subjects,
        attendance_percent: pct(present, total),
        avg_quiz_percent: avg,
        mrr: PLAN_PRICING[school.plan] ?? 0,
      },
      admins: admins.map((u) => toModel('users', u)),
    };
  }

  async createSchool(data: Record<string, unknown>) {
    const s = (k: string) => (typeof data[k] === 'string' ? data[k] : null);
    const now = new Date();
    const [row] = await this.db
      .insert(schoolsTable)
      .values({
        name: s('name')!,
        slug: `${strSlug(s('name')!)}-${strRandom(4)}`,
        code: s('code') ?? strRandom(6).toUpperCase(),
        email: s('email'),
        phone: s('phone'),
        city: s('city'),
        state: s('state'),
        country: s('country') ?? 'India',
        plan: s('plan') ?? 'free',
        plan_expires_at: dateValue(data.plan_expires_at),
        // Only the web form sends these (the API validates them away).
        max_teachers: int(data.max_teachers ?? 10),
        max_students: int(data.max_students ?? 500),
        ai_daily_token_limit: int(
          data.ai_daily_token_limit ??
            (Number(process.env.AI_DAILY_TOKEN_LIMIT) || 5000),
        ),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /** `$school->syllabi()->sync($ids)`: detach the others, attach the new ones. */
  async syncSyllabi(school: schools, ids: unknown) {
    const wanted = [
      ...new Set(
        (Array.isArray(ids) ? ids : []).map((i) => BigInt(i as string)),
      ),
    ];
    const current = (
      await this.db
        .select({ syllabus_id: school_syllabus.syllabus_id })
        .from(school_syllabus)
        .where(eq(school_syllabus.school_id, school.id))
        .orderBy(asc(school_syllabus.id))
    ).map((r) => r.syllabus_id);
    const detach = current.filter((c) => !wanted.includes(c));
    if (detach.length) {
      await this.db
        .delete(school_syllabus)
        .where(
          and(
            eq(school_syllabus.school_id, school.id),
            inArray(school_syllabus.syllabus_id, detach),
          ),
        );
    }
    const now = new Date();
    for (const id of wanted.filter((w) => !current.includes(w))) {
      await this.db.insert(school_syllabus).values({
        school_id: school.id,
        syllabus_id: id,
        created_at: now,
        updated_at: now,
      });
    }
  }

  /**
   * SuperAdminService::attachLogo: replace the logo file, then store it and
   * the theme derived from its colours (`settings.theme`).
   */
  async attachLogo(school: schools, logo: IncomingFile) {
    await this.storage.delete(school.logo);
    const url = await this.storage.store(
      logo,
      'image',
      `schools/${school.id}/logo`,
    );
    const theme = await themeFromImage(logo.buffer);
    const settings = jsonCast<Record<string, unknown>>(school.settings) ?? {};
    settings.theme = theme;
    const [row] = await this.db
      .update(schoolsTable)
      .set({
        logo: url,
        settings: phpJsonEncode(settings),
        updated_at: new Date(),
      })
      .where(eq(schoolsTable.id, school.id))
      .returning();
    return row;
  }

  /** `$school->fill(only([...]))->save()`: writes only what changed. */
  async updateSchool(school: schools, data: Record<string, unknown>) {
    const fields: Record<string, unknown> = {};
    for (const k of [
      'name',
      'email',
      'phone',
      'city',
      'state',
      'country',
      'plan',
    ] as const) {
      // Not in legacy: schools.plan is NOT NULL, so an empty plan means
      // "unchanged" (the web form's "Keep current") rather than a null write.
      if (k === 'plan' && !data[k]) continue;
      if (k in data) fields[k] = data[k];
    }
    if ('plan_expires_at' in data)
      fields.plan_expires_at = dateValue(data.plan_expires_at);
    // Only the web form sends these (the API validates them away).
    for (const k of [
      'max_teachers',
      'max_students',
      'ai_daily_token_limit',
    ] as const) {
      if (k in data) fields[k] = data[k] === null ? null : int(data[k]);
    }
    const dirty = dirtyFields(school, fields);
    if (!Object.keys(dirty).length) return school;
    const [row] = await this.db
      .update(schoolsTable)
      .set({ ...dirty, updated_at: new Date() })
      .where(eq(schoolsTable.id, school.id))
      .returning();
    return row;
  }

  async toggleSchool(school: schools) {
    const [row] = await this.db
      .update(schoolsTable)
      .set({
        status: school.status === 'active' ? 'inactive' : 'active',
        updated_at: new Date(),
      })
      .where(eq(schoolsTable.id, school.id))
      .returning();
    return row;
  }

  async platformUsers(
    role: string | null,
    schoolId: bigint | null,
    q: string | null,
    perPage: number,
    page: number,
  ) {
    const where = and(
      role ? eq(usersTable.role, role) : undefined,
      schoolId ? eq(usersTable.school_id, schoolId) : undefined,
      q
        ? or(
            containsCi(usersTable.name, q),
            containsCi(usersTable.email, q),
            containsCi(usersTable.phone, q),
          )
        : undefined,
    );
    const [items, total] = await Promise.all([
      this.db.query.users.findMany({
        where,
        orderBy: [myDesc(usersTable.created_at), asc(usersTable.id)],
        offset: (page - 1) * perPage,
        limit: perPage,
        with: { schools: { columns: { name: true, deleted_at: true } } },
      }),
      this.db.$count(usersTable, where),
    ]);
    return { items, total };
  }

  async revenue() {
    const all = await this.db.query.schools.findMany({
      where: LIVE_SCHOOL,
      orderBy: [asc(schoolsTable.id)],
    });
    const groups = new Map<string, schools[]>();
    for (const s of all) groups.set(s.plan, [...(groups.get(s.plan) ?? []), s]);
    const byPlan = [...groups.entries()]
      .map(([plan, list]) => ({
        plan,
        count: list.length,
        price: PLAN_PRICING[plan] ?? 0,
        mrr_contribution: list.length * (PLAN_PRICING[plan] ?? 0),
      }))
      .sort((a, b) => b.mrr_contribution - a.mrr_contribution);
    const mrr = byPlan.reduce((n, p) => n + p.mrr_contribution, 0);
    const col = schoolsTable.plan_expires_at;
    const expiring = await this.db.query.schools.findMany({
      where: and(
        LIVE_SCHOOL,
        isNotNull(col),
        dateCmp(col, '>=', new Date()),
        dateCmp(col, '<=', new Date(Date.now() + 30 * 86_400_000)),
      ),
      orderBy: [asc(col)],
      columns: { id: true, name: true, plan: true, plan_expires_at: true },
    });
    const byStatus = (st: string) => all.filter((s) => s.status === st).length;
    return {
      mrr,
      arr: mrr * 12,
      by_plan: byPlan,
      by_status: {
        active: byStatus('active'),
        inactive: byStatus('inactive'),
        suspended: byStatus('suspended'),
      },
      expiring_soon: expiring.map((s) => toModel('schools', s)),
    };
  }

  async aiUsage() {
    const sessions = await this.db.$count(ai_chat_sessions);
    const messages = await this.db.$count(ai_chat_messages);
    const [{ tokens: sum }] = await this.db
      .select({ tokens: mySum(ai_chat_messages.tokens) })
      .from(ai_chat_messages);
    const tokens = sum ?? 0;
    const top = await this.db
      .select({ user_id: ai_chat_sessions.user_id, sessions: count() })
      .from(ai_chat_sessions)
      .groupBy(ai_chat_sessions.user_id)
      .orderBy(
        desc(count(ai_chat_sessions.user_id)),
        asc(ai_chat_sessions.user_id),
      )
      .limit(5);
    const people = await this.db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(
        inArray(
          usersTable.id,
          top.map((t) => t.user_id),
        ),
      )
      .orderBy(asc(usersTable.id));
    const byId = new Map(people.map((p) => [p.id, p]));

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const date = dayAgo(i);
      days.push({
        date: monthDay(date),
        sessions: await this.db.$count(
          ai_chat_sessions,
          onDay(ai_chat_sessions.created_at, date),
        ),
        lessons: await this.db.$count(
          lesson_progress,
          onDay(lesson_progress.last_viewed_at, date),
        ),
        attempts: await this.db.$count(
          quiz_attempts,
          onDay(quiz_attempts.submitted_at, date),
        ),
      });
    }
    return {
      totals: {
        sessions,
        messages,
        tokens,
        avg_messages_per_session:
          sessions > 0 ? Math.round((messages / sessions) * 10) / 10 : 0,
      },
      top_users: top.map((t) => ({
        name: byId.get(t.user_id)?.name ?? 'Unknown',
        role: byId.get(t.user_id)?.role ?? null,
        sessions: t.sessions,
      })),
      engagement_14d: days,
    };
  }

  /**
   * SuperAdminService::systemHealth, for this stack: the same response shape,
   * checking what the Node app depends on (database and file storage).
   */
  async health() {
    const checks: {
      name: string;
      status: string;
      detail: string | null;
      latency_ms: number | null;
    }[] = [];
    const t0 = performance.now();
    try {
      const { rows } = await this.db.execute<{ db: string }>(
        sql`select current_database() as db`,
      );
      const [row] = rows;
      checks.push({
        name: 'PostgreSQL Database',
        status: 'healthy',
        detail: row?.db ?? null,
        latency_ms: Math.round((performance.now() - t0) * 10) / 10,
      });
    } catch (e) {
      checks.push({
        name: 'PostgreSQL Database',
        status: 'down',
        detail: String(e),
        latency_ms: null,
      });
    }
    if (this.storage.driver === 'r2') {
      checks.push({
        name: 'Storage',
        status: 'healthy',
        detail: `R2 bucket ${process.env.R2_BUCKET ?? ''}`,
        latency_ms: null,
      });
    } else {
      try {
        const fs = await statfs(
          StorageService.localDir().replace(/\/storage\/uploads$/, ''),
        );
        checks.push({
          name: 'Storage',
          status: 'healthy',
          detail: `${Math.round(((fs.bavail * fs.bsize) / 1024 ** 3) * 100) / 100} GB free`,
          latency_ms: null,
        });
      } catch (e) {
        checks.push({
          name: 'Storage',
          status: 'degraded',
          detail: String(e),
          latency_ms: null,
        });
      }
    }
    const overall = checks.every((c) => c.status === 'healthy')
      ? 'healthy'
      : checks.some((c) => c.status === 'down')
        ? 'down'
        : 'degraded';
    return {
      overall,
      checks,
      environment: process.env.NODE_ENV ?? 'production',
      node_version: process.version,
      app_url: process.env.PUBLIC_URL ?? null,
      checked_at: iso8601(new Date()),
    };
  }
}
