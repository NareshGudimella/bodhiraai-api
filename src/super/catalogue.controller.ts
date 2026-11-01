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
  Query,
} from '@nestjs/common';
import { and, count, eq, isNull } from 'drizzle-orm';
import { Roles } from '../common/decorators/auth.decorators';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { dirtyFields, phpBool, toModel } from '../common/http/eloquent';
import {
  forbidden,
  modelNotFound,
  phpJsonEncode,
  routeId,
} from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { pageFrom, pageMeta } from '../common/http/paginate';
import { Role } from '../common/roles';
import { ContentService } from '../content/content.service';
import { DB, type Db } from '../db/db';
import { asc, countOf, myDesc } from '../db/helpers';
import {
  chapters,
  plans as plansTable,
  school_syllabus,
  student_enquiries,
  subjects,
  syllabi as syllabiTable,
} from '../db/schema';
import type { plans, syllabi } from '../db/types';
import { strRandom, strSlug } from '../storage/laravel-str';

type Data = Record<string, unknown>;

const ENQUIRY_STATUSES = ['new', 'contacted', 'enrolled', 'closed'];
const int = (v: unknown) => Math.trunc(Number(v ?? 0)) || 0;

/**
 * New endpoints for the super admin catalogue, which legacy had only as web
 * routes: platform syllabi (Web\SyllabusController), plans
 * (Web\PlanController) and student enquiries (Web\SuperAdminController).
 */
@Controller('super')
@Roles(Role.SuperAdmin)
export class CatalogueController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly content: ContentService,
  ) {}

  private async syllabus(raw: string) {
    const id = routeId(raw, 'Syllabus');
    const s = await this.db.query.syllabi.findFirst({
      where: eq(syllabiTable.id, id),
    });
    if (!s) throw modelNotFound('Syllabus', id);
    return s;
  }

  /** Bound Subject that must be a platform subject of the syllabus (else a bare abort). */
  private async syllabusSubject(s: syllabi, raw: string, status: 403 | 404) {
    const id = routeId(raw, 'Subject');
    const subject = await this.db.query.subjects.findFirst({
      where: eq(subjects.id, id),
    });
    if (!subject) throw modelNotFound('Subject', id);
    if (subject.syllabus_id !== s.id || subject.school_id !== null) {
      throw status === 403 ? forbidden() : new ApiException('HTTP error', 404);
    }
    return subject;
  }

  /** SyllabusController::validateSyllabus: board + grade unique together. */
  private validateSyllabus(body: unknown, ignore?: bigint) {
    const board = (body as Data | null)?.board;
    const where = `board,${typeof board === 'string' ? board : 'NULL'}`;
    return laravelValidate(this.db, body, {
      board: ['required', 'string', 'max:30'],
      grade: [
        'required',
        'string',
        'max:10',
        `unique:syllabi,grade,${ignore ?? 'NULL'},id,${where}`,
      ],
      name: ['required', 'string', 'max:120'],
      description: ['nullable', 'string'],
      sort_order: ['nullable', 'integer', 'min:0', 'max:9999'],
      is_active: ['nullable', 'boolean'],
    });
  }

  /** Validated syllabus attributes (present keys only, like fill()). */
  private syllabusFields(data: Data) {
    const out: Data = {};
    for (const k of ['board', 'grade', 'name', 'description'])
      if (k in data) out[k] = data[k];
    // A blank sort_order or is_active becomes NULL, which the NOT NULL column
    // rejects (a 500 in legacy too).
    if ('sort_order' in data)
      out.sort_order = data.sort_order === null ? null : int(data.sort_order);
    if ('is_active' in data)
      out.is_active = data.is_active === null ? null : phpBool(data.is_active);
    return out;
  }

  @Get('syllabi')
  async syllabi() {
    const rows = await this.db.query.syllabi.findMany({
      orderBy: [
        asc(syllabiTable.sort_order),
        asc(syllabiTable.board),
        asc(syllabiTable.grade),
        asc(syllabiTable.id),
      ],
      extras: (t) => ({
        subjects_count: countOf(subjects, 'syllabus_id', t.id).as(
          'subjects_count',
        ),
        schools_count: countOf(school_syllabus, 'syllabus_id', t.id).as(
          'schools_count',
        ),
      }),
    });
    return ok(
      rows.map(({ subjects_count, schools_count, ...s }) =>
        toModel('syllabi', s, { subjects_count, schools_count }),
      ),
    );
  }

  @Post('syllabi')
  async syllabusStore(@Body() body: unknown) {
    const data = await this.validateSyllabus(body);
    const board = data.board as string;
    const now = new Date();
    const [s] = await this.db
      .insert(syllabiTable)
      .values({
        ...(this.syllabusFields(data) as Pick<
          syllabi,
          'board' | 'grade' | 'name'
        >),
        slug: `${board.replace(/_/g, '-').toLowerCase()}-grade-${data.grade as string}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    return ok({ id: s.id }, `Syllabus '${s.name}' created.`);
  }

  @Get('syllabi/:syllabus')
  async syllabusShow(@Param('syllabus') raw: string) {
    const s = await this.syllabus(raw);
    const rows = await this.db.query.subjects.findMany({
      where: and(eq(subjects.syllabus_id, s.id), isNull(subjects.school_id)),
      orderBy: [asc(subjects.sort_order), asc(subjects.name), asc(subjects.id)],
      extras: (t) => ({
        chapters_count: countOf(chapters, 'subject_id', t.id).as(
          'chapters_count',
        ),
      }),
    });
    return ok({
      syllabus: toModel('syllabi', s),
      subjects: rows.map(({ chapters_count, ...x }) =>
        toModel('subjects', x, { chapters_count }),
      ),
    });
  }

  @Patch('syllabi/:syllabus')
  async syllabusUpdate(@Param('syllabus') raw: string, @Body() body: unknown) {
    const s = await this.syllabus(raw);
    const data = await this.validateSyllabus(body, s.id);
    const fields = dirtyFields(s, this.syllabusFields(data));
    if (Object.keys(fields).length) {
      await this.db
        .update(syllabiTable)
        .set({ ...fields, updated_at: new Date() })
        .where(eq(syllabiTable.id, s.id));
    }
    return ok({ id: s.id }, 'Syllabus updated.');
  }

  @Delete('syllabi/:syllabus')
  async syllabusDestroy(@Param('syllabus') raw: string) {
    const s = await this.syllabus(raw);
    await this.db.delete(syllabiTable).where(eq(syllabiTable.id, s.id));
    return ok(null, 'Syllabus deleted.');
  }

  @Post('syllabi/:syllabus/subjects')
  async subjectStore(@Param('syllabus') raw: string, @Body() body: unknown) {
    const s = await this.syllabus(raw);
    const data = await laravelValidate(this.db, body, {
      name: ['required', 'string', 'max:120'],
      icon: ['nullable', 'string', 'max:8'],
      color: ['nullable', 'string', 'max:20'],
      description: ['nullable', 'string'],
    });
    const name = data.name as string;
    const now = new Date();
    const [subject] = await this.db
      .insert(subjects)
      .values({
        syllabus_id: s.id,
        school_id: null,
        name,
        slug: `${strSlug(name)}-${strRandom(4)}`,
        grade: s.grade,
        icon: (data.icon as string | null | undefined) ?? '📘',
        color: (data.color as string | null | undefined) ?? '#C49560',
        description: (data.description as string | null | undefined) ?? null,
        is_active: true,
        created_at: now,
        updated_at: now,
      })
      .returning();
    return ok({ id: subject.id }, 'Subject added to syllabus.');
  }

  @Get('syllabi/:syllabus/subjects/:subject')
  async subjectShow(
    @Param('syllabus') raw: string,
    @Param('subject') subjectRaw: string,
  ) {
    const s = await this.syllabus(raw);
    const subject = await this.syllabusSubject(s, subjectRaw, 404);
    const chapters = await this.content.chaptersFor(subject);
    return ok({
      syllabus: toModel('syllabi', s),
      subject: toModel('subjects', subject),
      chapters: chapters.map(({ lessons_count, ...c }) =>
        toModel('chapters', c, { lessons_count }),
      ),
    });
  }

  @Delete('syllabi/:syllabus/subjects/:subject')
  async subjectDestroy(
    @Param('syllabus') raw: string,
    @Param('subject') subjectRaw: string,
  ) {
    const s = await this.syllabus(raw);
    const subject = await this.syllabusSubject(s, subjectRaw, 403);
    await this.db.delete(subjects).where(eq(subjects.id, subject.id));
    return ok(null, 'Subject removed.');
  }

  @Post('syllabi/:syllabus/subjects/:subject/chapters')
  async chapterStore(
    @Param('syllabus') raw: string,
    @Param('subject') subjectRaw: string,
    @Body() body: unknown,
  ) {
    const s = await this.syllabus(raw);
    const subject = await this.syllabusSubject(s, subjectRaw, 404);
    const data = await laravelValidate(this.db, body, {
      title: ['required', 'string', 'max:160'],
      description: ['nullable', 'string'],
    });
    const c = await this.content.createChapter(subject, data);
    return ok({ id: c.id }, 'Chapter added.');
  }

  // ── Plans ──

  private async plan(raw: string) {
    const id = routeId(raw, 'Plan');
    const p = await this.db.query.plans.findFirst({
      where: eq(plansTable.id, id),
    });
    if (!p) throw modelNotFound('Plan', id);
    return p;
  }

  private validatePlan(body: unknown, plan?: plans) {
    return laravelValidate(this.db, body, {
      key: [
        'nullable',
        'string',
        'max:50',
        'regex:/^[a-z0-9_]+$/',
        `unique:plans,key${plan ? `,${plan.id}` : ''}`,
      ],
      audience: ['required', 'in:individual,school'],
      name: ['required', 'string', 'max:100'],
      tagline: ['nullable', 'string', 'max:200'],
      description: ['nullable', 'string'],
      features: ['nullable', 'string'], // newline-separated in the form
      monthly_price: ['required', 'integer', 'min:0', 'max:9999999'],
      yearly_price: ['required', 'integer', 'min:0', 'max:99999999'],
      trial_days: ['nullable', 'integer', 'min:0', 'max:90'],
      is_featured: ['nullable', 'boolean'],
      is_active: ['nullable', 'boolean'],
      sort_order: ['nullable', 'integer', 'min:0', 'max:9999'],
    });
  }

  /** PlanController::payload. */
  private planPayload(data: Data) {
    // Legacy reads $data['key'] directly: a request without the field is a 500.
    if (!('key' in data)) throw new ApiException('Server error', 500);
    const name = data.name as string;
    const features = String((data.features as string | null | undefined) ?? '')
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f !== '' && f !== '0');
    return {
      key: (data.key as string | null) || strSlug(name, '_'),
      audience: data.audience as string,
      name,
      tagline: (data.tagline as string | null | undefined) ?? null,
      description: (data.description as string | null | undefined) ?? null,
      features: phpJsonEncode(features),
      monthly_price: int(data.monthly_price),
      yearly_price: int(data.yearly_price),
      trial_days: int(data.trial_days ?? 0),
      is_featured: phpBool(data.is_featured ?? false),
      is_active: phpBool(data.is_active ?? true),
      sort_order: int(data.sort_order ?? 0),
    };
  }

  @Get('plans')
  async plans() {
    const rows = await this.db.query.plans.findMany({
      orderBy: [
        asc(plansTable.audience),
        asc(plansTable.sort_order),
        asc(plansTable.name),
        asc(plansTable.id),
      ],
    });
    return ok(rows.map((p) => toModel('plans', p)));
  }

  @Get('plans/:plan')
  async planShow(@Param('plan') raw: string) {
    return ok(toModel('plans', await this.plan(raw)));
  }

  @Post('plans')
  async planStore(@Body() body: unknown) {
    const data = await this.validatePlan(body);
    const now = new Date();
    const [p] = await this.db
      .insert(plansTable)
      .values({ ...this.planPayload(data), created_at: now, updated_at: now })
      .returning();
    return ok({ id: p.id }, 'Plan created.');
  }

  @Patch('plans/:plan')
  async planUpdate(@Param('plan') raw: string, @Body() body: unknown) {
    const plan = await this.plan(raw);
    const data = await this.validatePlan(body, plan);
    const fields = dirtyFields(plan, this.planPayload(data));
    if (Object.keys(fields).length) {
      await this.db
        .update(plansTable)
        .set({ ...fields, updated_at: new Date() })
        .where(eq(plansTable.id, plan.id));
    }
    return ok({ id: plan.id }, 'Plan updated.');
  }

  @Delete('plans/:plan')
  async planDestroy(@Param('plan') raw: string) {
    const plan = await this.plan(raw);
    await this.db.delete(plansTable).where(eq(plansTable.id, plan.id));
    return ok(null, 'Plan deleted.');
  }

  @Post('plans/:plan/toggle')
  @HttpCode(200)
  async planToggle(@Param('plan') raw: string) {
    const plan = await this.plan(raw);
    const [p] = await this.db
      .update(plansTable)
      .set({ is_active: !plan.is_active, updated_at: new Date() })
      .where(eq(plansTable.id, plan.id))
      .returning();
    return ok(
      { is_active: p.is_active },
      p.is_active ? `Plan ${p.name} is now active.` : `Plan ${p.name} hidden.`,
    );
  }

  // ── Student enquiries ──

  @Get('enquiries')
  async enquiries(@Query() query: Record<string, unknown>) {
    // `$request->string('status')->toString() ?: null`: no validation.
    const status =
      typeof query.status === 'string' && query.status !== ''
        ? query.status
        : null;
    const where = status ? eq(student_enquiries.status, status) : undefined;
    const page = pageFrom(query.page);
    const [rows, total, groups] = await Promise.all([
      this.db.query.student_enquiries.findMany({
        where,
        orderBy: [
          myDesc(student_enquiries.created_at),
          asc(student_enquiries.id),
        ],
        offset: (page - 1) * 20,
        limit: 20,
      }),
      this.db.$count(student_enquiries, where),
      // Legacy returned the groups in status order.
      this.db
        .select({ status: student_enquiries.status, n: count() })
        .from(student_enquiries)
        .groupBy(student_enquiries.status)
        .orderBy(asc(student_enquiries.status)),
    ]);
    return ok(
      {
        enquiries: rows.map((e) => toModel('student_enquiries', e)),
        counts: Object.fromEntries(groups.map((g) => [g.status, g.n])),
        status,
      },
      null,
      pageMeta(page, 20, total),
    );
  }

  @Patch('enquiries/:enquiry')
  async enquiryStatus(@Param('enquiry') raw: string, @Body() body: unknown) {
    const id = routeId(raw, 'StudentEnquiry');
    const e = await this.db.query.student_enquiries.findFirst({
      where: eq(student_enquiries.id, id),
    });
    if (!e) throw modelNotFound('StudentEnquiry', id);
    const data = await laravelValidate(this.db, body, {
      status: ['required', `in:${ENQUIRY_STATUSES.join(',')}`],
    });
    const fields = dirtyFields(e, { status: data.status });
    if (Object.keys(fields).length) {
      await this.db
        .update(student_enquiries)
        .set({ ...fields, updated_at: new Date() })
        .where(eq(student_enquiries.id, id));
    }
    return ok({ status: data.status }, 'Enquiry updated.');
  }
}
