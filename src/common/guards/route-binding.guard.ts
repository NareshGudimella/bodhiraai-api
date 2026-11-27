// Not in legacy (2026-11-27, docs/slug-contract.md): route parameters may carry a slug or public_id.
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Request } from 'express';
import { DB, type Db } from '../../db/db';
import { IS_PUBLIC } from '../decorators/auth.decorators';
import {
  ai_chat_sessions,
  assignments,
  blog_categories,
  chapters,
  classes,
  conversations,
  faqs,
  features,
  invoices,
  lessons,
  live_classes,
  plans,
  quiz_attempts,
  quizzes,
  schools,
  services,
  social_links,
  subjects,
  subscriptions,
  syllabi,
  team_members,
  testimonials,
  users,
} from '../../db/schema';

type Target = readonly [table: PgTable, column: AnyPgColumn];

/** Route parameter name → the table and the column its slug / public_id lives in. */
const BY_PARAM: Record<string, Target> = {
  subject: [subjects, subjects.url_slug],
  chapter: [chapters, chapters.url_slug],
  lesson: [lessons, lessons.url_slug],
  quiz: [quizzes, quizzes.slug],
  class: [classes, classes.slug],
  school: [schools, schools.slug],
  plan: [plans, plans.slug],
  syllabus: [syllabi, syllabi.slug],
  live: [live_classes, live_classes.slug],
  assignment: [assignments, assignments.slug],
  user: [users, users.public_id],
  student: [users, users.public_id],
  other: [users, users.public_id],
  attempt: [quiz_attempts, quiz_attempts.public_id],
  invoice: [invoices, invoices.public_id],
  subscription: [subscriptions, subscriptions.public_id],
  conversation: [conversations, conversations.public_id],
  session: [ai_chat_sessions, ai_chat_sessions.public_id],
};

/** `:id` of the CMS collections (`/cms/<collection>/:id`). */
const CMS_BY_COLLECTION: Record<string, Target> = {
  services: [services, services.slug],
  categories: [blog_categories, blog_categories.slug],
  features: [features, features.public_id],
  faqs: [faqs, faqs.public_id],
  testimonials: [testimonials, testimonials.public_id],
  team: [team_members, team_members.public_id],
  social: [social_links, social_links.public_id],
};

/**
 * Route binding for slugs and public ids. All digits stays an id (mobile app, old links);
 * anything else is looked up in the entity's slug / public_id column and the param is
 * rewritten to the numeric id, so every controller, access check and 404/403 behaves as
 * for an id. An unknown value is left as it is and misses the way a non-numeric id does.
 * Runs last among the global guards, after the token and role checks, so nothing is
 * looked up for an unauthenticated or wrong-role caller. security: not in legacy: routes
 * marked @Public() are skipped entirely (no lookup an anonymous caller could use as an
 * oracle or to load the database): their params are numeric ids (HLS, upload stream) or
 * handled by the route itself (blog slugs).
 */
@Injectable()
export class RouteBindingGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    )
      return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const params = req.params as Record<string, string> | undefined;
    if (!params) return true;
    const path: string =
      (req.route as { path?: string } | undefined)?.path ?? '';
    for (const [name, raw] of Object.entries(params)) {
      if (typeof raw !== 'string' || /^\d+$/.test(raw)) continue;
      const target =
        name === 'id'
          ? CMS_BY_COLLECTION[/\/cms\/(\w+)\/:id/.exec(path)?.[1] ?? '']
          : BY_PARAM[name];
      if (!target) continue;
      const [table, column] = target;
      const [row] = await this.db
        .select({ id: (table as unknown as { id: AnyPgColumn }).id })
        .from(table)
        .where(eq(column, raw))
        .limit(1);
      if (row) params[name] = String(row.id);
    }
    return true;
  }
}
