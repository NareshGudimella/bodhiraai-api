import {
  DATE_AFTER,
  DATE_BEFORE,
  ID_MAX,
  PHONE_FORMAT,
} from '../common/http/rules';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { RateLimit } from '../common/decorators/rate-limit';
import { FileInterceptor } from '@nestjs/platform-express';
import { and, desc, eq } from 'drizzle-orm';
import { Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { toModel } from '../common/http/eloquent';
import { iso8601 } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { pageFrom, pageMeta } from '../common/http/paginate';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { assertNotDirect } from '../common/direct-school';
import { asc } from '../db/helpers';
import { school_syllabus, syllabi, video_sessions } from '../db/schema';
import type { IncomingFile } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFiles,
} from '../storage/uploads';
import { PLAN_PRICING, SuperService } from './super.service';

const PLANS = `in:${Object.keys(PLAN_PRICING).join(',')}`;

const SCHOOL_RULES = {
  name: ['required', 'string', 'max:160'],
  email: ['nullable', 'email', 'max:160'],
  phone: ['nullable', 'string', 'max:20', PHONE_FORMAT],
  city: ['nullable', 'string', 'max:80'],
  state: ['nullable', 'string', 'max:80'],
  country: ['nullable', 'string', 'max:80'],
  plan: ['nullable', PLANS],
  plan_expires_at: ['nullable', 'date', DATE_AFTER, DATE_BEFORE],
};

/** Web\SuperAdminController's school form: the API rules plus limits, syllabi and a logo. */
const WEB_SCHOOL_RULES = {
  ...SCHOOL_RULES,
  max_teachers: ['nullable', 'integer', 'min:0', 'max:100000'],
  max_students: ['nullable', 'integer', 'min:0', 'max:1000000'],
  ai_daily_token_limit: ['nullable', 'integer', 'min:0', 'max:10000000'],
  syllabi: ['nullable', 'array', 'max:200'],
  'syllabi.*': ['integer', 'min:1', 'exists:syllabi,id'],
  logo: [],
};

/** schoolStore's rules: `code` (create only) comes right after `name`. */
const { name: schoolName, ...afterName } = WEB_SCHOOL_RULES;
const WEB_CREATE_RULES = {
  name: schoolName,
  code: ['nullable', 'string', 'max:20', 'unique:schools,code'],
  ...afterName,
};

const LOGO_RULE = {
  field: 'logo',
  kind: 'image' as const,
  maxKb: 5120,
  mimes: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
};

/** /api/v1/super/* — port of Api\V1\SuperAdmin\SuperAdminApiController. */
@Controller('super')
@Roles(Role.SuperAdmin)
export class SuperController {
  constructor(
    private readonly sup: SuperService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Route-model binding for School (soft-deleted schools 404). */
  private findSchool(raw: string) {
    return this.sup.findSchool(raw);
  }

  @Get('home')
  async home() {
    return ok(await this.sup.dashboard());
  }

  @Get('schools')
  async schools(@Query() query: Record<string, unknown>) {
    const data = await laravelValidate(this.db, query, {
      q: ['nullable', 'string', 'max:120'],
      status: ['nullable', 'in:active,inactive,suspended'],
      plan: ['nullable', PLANS],
      per_page: ['nullable', 'integer', 'min:1', 'max:100'],
    });
    const perPage = data.per_page ? Number(data.per_page) : 20;
    const page = pageFrom(query.page);
    const { items, total } = await this.sup.paginatedSchools(
      (data.q as string | null) ?? null,
      (data.status as string | null) ?? null,
      (data.plan as string | null) ?? null,
      perPage,
      page,
    );
    return ok(
      items.map((s) => ({
        id: s.id,
        slug: s.slug, // not in legacy
        name: s.name,
        code: s.code,
        email: s.email,
        plan: s.plan,
        status: s.status,
        users_count: s.users_count,
        classes_count: s.classes_count,
        // not in legacy: Bodhira Direct, the default school (2026-11-01)
        is_direct: s.is_direct,
        // not in legacy API: the Blade list shows the location
        city: s.city,
        state: s.state,
        plan_expires_at: s.plan_expires_at
          ? s.plan_expires_at.toISOString().slice(0, 10)
          : null,
      })),
      null,
      pageMeta(page, perPage, total),
    );
  }

  @Post('schools')
  async createSchool(@Body() body: unknown) {
    const data = await laravelValidate(this.db, body, {
      ...SCHOOL_RULES,
      code: ['nullable', 'string', 'max:20', 'unique:schools,code'],
    });
    const s = await this.sup.createSchool(data);
    return ok({ id: s.id, slug: s.slug, code: s.code }, 'School created.');
  }

  /** New (web form): active syllabi to offer, and the school's current ones. */
  @Get('schools/form-options')
  async schoolFormOptions(@Query('school') raw?: string) {
    const rows = await this.db.query.syllabi.findMany({
      where: eq(syllabi.is_active, true),
      orderBy: [
        asc(syllabi.board),
        asc(syllabi.grade),
        asc(syllabi.name),
        asc(syllabi.id),
      ],
    });
    const selected = raw
      ? (
          await this.db
            .select({ syllabus_id: school_syllabus.syllabus_id })
            .from(school_syllabus)
            .where(
              eq(school_syllabus.school_id, (await this.findSchool(raw)).id),
            )
            .orderBy(asc(school_syllabus.id))
        ).map((r) => r.syllabus_id)
      : [];
    return ok({
      syllabi: rows.map((x) => toModel('syllabi', x)),
      selected,
      // not in legacy: the web plan select shows each plan's monthly price
      plan_prices: PLAN_PRICING,
    });
  }

  /** New (web form, multipart): Web\SuperAdminController::schoolStore. */
  @Post('schools/web')
  @RateLimit(10, 'user') // security: not in legacy: counted before the upload is buffered
  @UseInterceptors(FileInterceptor('logo', uploadOptions(6)))
  async createSchoolWeb(
    @Body() body: unknown,
    @UploadedFile() logo?: IncomingFile,
  ) {
    const data = await validateWithFiles(
      this.db,
      body,
      WEB_CREATE_RULES,
      { logo },
      [LOGO_RULE],
    );
    let s = await this.sup.createSchool(data);
    if (Array.isArray(data.syllabi) && data.syllabi.length) {
      await this.sup.syncSyllabi(s, data.syllabi);
    }
    if (logo)
      s = await storeOrReject('logo', () => this.sup.attachLogo(s, logo));
    return ok(
      { id: s.id, slug: s.slug, code: s.code },
      `School ${s.name} created (code: ${s.code}).`,
    );
  }

  /** New (web form, multipart): Web\SuperAdminController::schoolUpdate. */
  @Post('schools/:school/web')
  @HttpCode(200)
  @RateLimit(10, 'user') // security: not in legacy: counted before the upload is buffered
  @UseInterceptors(FileInterceptor('logo', uploadOptions(6)))
  async updateSchoolWeb(
    @Param('school') raw: string,
    @Body() body: unknown,
    @UploadedFile() logo?: IncomingFile,
  ) {
    const school = await this.findSchool(raw);
    const data = await validateWithFiles(
      this.db,
      body,
      WEB_SCHOOL_RULES,
      { logo },
      [LOGO_RULE],
    );
    const s = await this.sup.updateSchool(school, data);
    if ('syllabi' in data) await this.sup.syncSyllabi(s, data.syllabi ?? []);
    if (logo) await storeOrReject('logo', () => this.sup.attachLogo(s, logo));
    return ok({ id: school.id, slug: school.slug }, 'School updated.');
  }

  @Get('schools/:school')
  async school(@Param('school') raw: string) {
    return ok(await this.sup.schoolDetail(await this.findSchool(raw)));
  }

  @Patch('schools/:school')
  async updateSchool(@Param('school') raw: string, @Body() body: unknown) {
    const school = await this.findSchool(raw);
    const data = await laravelValidate(this.db, body, SCHOOL_RULES);
    await this.sup.updateSchool(school, data);
    return ok({ id: school.id, slug: school.slug }, 'School updated.');
  }

  @Post('schools/:school/toggle')
  @HttpCode(200)
  async toggleSchool(@Param('school') raw: string) {
    const school = await this.findSchool(raw);
    assertNotDirect(school, 'be deactivated'); // not in legacy
    const s = await this.sup.toggleSchool(school);
    return ok({ status: s.status }, 'Status toggled.');
  }

  @Get('users')
  async users(@Query() query: Record<string, unknown>) {
    const data = await laravelValidate(this.db, query, {
      role: ['nullable', `in:${Object.values(Role).join(',')}`],
      school_id: ['nullable', 'exists:schools,id'],
      q: ['nullable', 'string', 'max:120'],
      per_page: ['nullable', 'integer', 'min:1', 'max:200'],
    });
    const perPage = data.per_page ? Number(data.per_page) : 25;
    const page = pageFrom(query.page);
    const { items, total } = await this.sup.platformUsers(
      (data.role as string | null) ?? null,
      data.school_id ? BigInt(data.school_id as string) : null,
      (data.q as string | null) ?? null,
      perPage,
      page,
    );
    return ok(
      items.map((u) => ({
        id: u.id,
        public_id: u.public_id, // not in legacy
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        // `$u->school` excludes soft-deleted schools.
        school: u.schools && !u.schools.deleted_at ? u.schools.name : null,
        status: u.status,
        created_at: iso8601(u.created_at),
      })),
      null,
      pageMeta(page, perPage, total),
    );
  }

  /** not in legacy: read-only playback audit (docs/video-hls-contract.md), newest first, 50 a page. */
  @Get('video-sessions')
  async videoSessions(@Query() query: Record<string, unknown>) {
    const data = await laravelValidate(this.db, query, {
      user: ['nullable', 'integer', 'min:1', `max:${ID_MAX}`],
      lesson: ['nullable', 'integer', 'min:1', `max:${ID_MAX}`],
    });
    const perPage = 50;
    const page = pageFrom(query.page);
    const where = and(
      data.user
        ? eq(video_sessions.user_id, BigInt(data.user as string))
        : undefined,
      data.lesson
        ? eq(video_sessions.lesson_id, BigInt(data.lesson as string))
        : undefined,
    );
    const items = await this.db
      .select()
      .from(video_sessions)
      .where(where)
      .orderBy(desc(video_sessions.created_at), asc(video_sessions.id))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const total = await this.db.$count(video_sessions, where);
    return ok(
      items.map((r) => ({
        ...r,
        created_at: iso8601(r.created_at),
        key_deadline: iso8601(r.key_deadline),
        segments_until: iso8601(r.segments_until),
        revoked_at: r.revoked_at ? iso8601(r.revoked_at) : null,
      })),
      null,
      pageMeta(page, perPage, total),
    );
  }

  @Get('revenue')
  async revenue() {
    return ok(await this.sup.revenue());
  }

  @Get('ai-usage')
  async aiUsage() {
    return ok(await this.sup.aiUsage());
  }

  /** Same shape as legacy; reports this stack's runtime (see SuperService.health). */
  @Get('health')
  async health() {
    return ok(await this.sup.health());
  }
}
