import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { ok } from '../common/http/api-response';
import { dirtyFields, toModel } from '../common/http/eloquent';
import {
  modelNotFound,
  phpJsonDecode,
  phpJsonEncode,
  routeId,
  sameJson,
} from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { countOf } from '../db/helpers';
import {
  page_sections as pageSectionsTable,
  pages as pagesTable,
} from '../db/schema';
import type { page_sections, pages, users } from '../db/types';
import { strSlug } from '../storage/laravel-str';
import { StorageService } from '../storage/storage.service';
import {
  storeOrReject,
  uploadOptions,
  validateWithFiles,
} from '../storage/uploads';
import { AuditService, CMS_MODEL } from './audit.service';
import type { MulterFile } from './cms-resource.controller';
import { SECTION_TYPES } from './cms.schema';

type Data = Record<string, unknown>;

/** `(bool) $x`. */
const bool = (v: unknown) =>
  !(
    v === null ||
    v === undefined ||
    v === false ||
    v === 0 ||
    v === '' ||
    v === '0'
  );

/**
 * `json_decode($s, true)` kept only when valid (json_last_error() === NONE),
 * re-encoded as the `array` cast stores it. `null` JSON decodes fine to null.
 */
function jsonField(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw === '0') return null;
  try {
    JSON.parse(raw);
  } catch {
    return null;
  }
  const decoded = phpJsonDecode(raw);
  return decoded === null ? null : phpJsonEncode(decoded);
}

/**
 * Port of App\Http\Controllers\Cms\PageController: page settings and the
 * section builder. Pages bind by slug, sections by id.
 */
@Controller('cms')
@Roles(Role.SuperAdmin, Role.WebAdmin)
export class CmsPagesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /** Route binding by slug (soft-deleted pages don't match). */
  private async page(slug: string) {
    const page = await this.db.query.pages.findFirst({
      where: and(eq(pagesTable.slug, slug), isNull(pagesTable.deleted_at)),
      orderBy: [asc(pagesTable.id)],
    });
    if (!page) throw modelNotFound('Cms\\Page', slug);
    return page;
  }

  private async section(raw: string) {
    const id = routeId(raw, 'Cms\\PageSection');
    const s = await this.db.query.page_sections.findFirst({
      where: eq(pageSectionsTable.id, id),
    });
    if (!s) throw modelNotFound('Cms\\PageSection', id);
    return s;
  }

  private subject(type: 'Page' | 'PageSection', id: bigint) {
    return { type: CMS_MODEL(type), id };
  }

  @Get('pages')
  async index() {
    const pages = await this.db.query.pages.findMany({
      where: isNull(pagesTable.deleted_at),
      orderBy: [
        asc(pagesTable.sort_order),
        asc(pagesTable.name),
        asc(pagesTable.id),
      ],
      extras: (t) => ({
        sections_count: countOf(pageSectionsTable, 'page_id', t.id).as(
          'sections_count',
        ),
      }),
    });
    return ok(
      pages.map(({ sections_count, ...p }) =>
        toModel('pages', p, { sections_count }),
      ),
    );
  }

  @Post('pages')
  async store(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Body() body: unknown,
  ) {
    const data = await this.validatePage(body);
    const now = new Date();
    const [page] = await this.db
      .insert(pagesTable)
      .values({
        ...(this.payload(data) as Partial<pages> as pages),
        created_at: now,
        updated_at: now,
      })
      .returning();
    await this.audit.log(
      user,
      client,
      'cms.page.created',
      this.subject('Page', page.id),
    );
    return ok({ slug: page.slug }, 'Page created — now add sections.');
  }

  @Get('pages/:page')
  async edit(@Param('page') slug: string) {
    const page = await this.page(slug);
    const sections = await this.db.query.page_sections.findMany({
      where: eq(pageSectionsTable.page_id, page.id),
      orderBy: [asc(pageSectionsTable.sort_order), asc(pageSectionsTable.id)],
    });
    return ok({
      page: toModel('pages', page, {
        sections: sections.map((s) => toModel('page_sections', s)),
      }),
      section_types: SECTION_TYPES,
    });
  }

  @Patch('pages/:page')
  async update(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('page') slug: string,
    @Body() body: unknown,
  ) {
    const page = await this.page(slug);
    const data = await this.validatePage(body, page.id);
    const payload = this.payload(data);
    const changed: Data = dirtyFields(page, { ...payload, schema: undefined });
    delete changed.schema;
    if (
      payload.schema === null
        ? page.schema !== null
        : !sameJson(page.schema, payload.schema)
    ) {
      changed.schema = payload.schema;
    }
    if (Object.keys(changed).length) {
      await this.db
        .update(pagesTable)
        .set({ ...changed, updated_at: new Date() })
        .where(eq(pagesTable.id, page.id));
    }
    await this.audit.log(
      user,
      client,
      'cms.page.updated',
      this.subject('Page', page.id),
    );
    return ok({ slug: payload.slug }, 'Page settings saved.');
  }

  @Delete('pages/:page')
  async destroy(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('page') slug: string,
  ) {
    const page = await this.page(slug);
    if (page.is_system) {
      // Legacy redirects back with this status and keeps the page.
      return ok({ deleted: false }, 'System pages cannot be deleted.');
    }
    const now = new Date();
    await this.db
      .update(pagesTable)
      .set({ deleted_at: now, updated_at: now })
      .where(eq(pagesTable.id, page.id));
    await this.audit.log(
      user,
      client,
      'cms.page.deleted',
      this.subject('Page', page.id),
    );
    return ok({ deleted: true }, 'Page deleted.');
  }

  // ---- Sections ------------------------------------------------------

  @Post('pages/:page/sections')
  @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 1)))
  async sectionStore(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('page') slug: string,
    @Body() body: unknown,
    @UploadedFiles() files: MulterFile[] = [],
  ) {
    const page = await this.page(slug);
    const values = await this.fillSection(null, body, files);
    const [last] = await this.db
      .select({ sort_order: max(pageSectionsTable.sort_order) })
      .from(pageSectionsTable)
      .where(eq(pageSectionsTable.page_id, page.id));
    const now = new Date();
    const [section] = await this.db
      .insert(pageSectionsTable)
      .values({
        ...values,
        page_id: page.id,
        sort_order: (last.sort_order ?? -1) + 1,
        created_at: now,
        updated_at: now,
      })
      .returning();
    await this.audit.log(
      user,
      client,
      'cms.section.created',
      this.subject('PageSection', section.id),
    );
    return ok({ id: section.id }, 'Section added.');
  }

  @Patch('sections/:section')
  @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 1)))
  async sectionUpdate(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('section') raw: string,
    @Body() body: unknown,
    @UploadedFiles() files: MulterFile[] = [],
  ) {
    const section = await this.section(raw);
    const values = await this.fillSection(section, body, files);
    const changed: Data = dirtyFields(section, { ...values, data: undefined });
    delete changed.data;
    if (
      values.data === null
        ? section.data !== null
        : !sameJson(section.data, values.data)
    ) {
      changed.data = values.data;
    }
    if (Object.keys(changed).length) {
      await this.db
        .update(pageSectionsTable)
        .set({ ...changed, updated_at: new Date() })
        .where(eq(pageSectionsTable.id, section.id));
    }
    await this.audit.log(
      user,
      client,
      'cms.section.updated',
      this.subject('PageSection', section.id),
    );
    return ok({ id: section.id }, 'Section updated.');
  }

  @Delete('sections/:section')
  async sectionDestroy(@Param('section') raw: string) {
    const section = await this.section(raw);
    await this.db
      .delete(pageSectionsTable)
      .where(eq(pageSectionsTable.id, section.id));
    return ok(null, 'Section removed.');
  }

  @Post('sections/:section/toggle')
  async sectionToggle(@Param('section') raw: string) {
    const section = await this.section(raw);
    const active = !section.is_active;
    await this.db
      .update(pageSectionsTable)
      .set({ is_active: active, updated_at: new Date() })
      .where(eq(pageSectionsTable.id, section.id));
    return ok(
      { is_active: active },
      active ? 'Section shown.' : 'Section hidden.',
    );
  }

  /** Persist a new section order: ids[] in the desired order (Eloquent builder update touches updated_at). */
  @Post('pages/:page/sections/reorder')
  async sectionReorder(@Param('page') slug: string, @Body() body: unknown) {
    const page = await this.page(slug);
    const data = await laravelValidate(this.db, body, {
      ids: ['required', 'array'],
      'ids.*': ['integer'],
    });
    const ids = Object.values(data.ids as object) as (string | number)[];
    const now = new Date();
    for (const [i, id] of ids.entries()) {
      await this.db
        .update(pageSectionsTable)
        .set({ sort_order: i, updated_at: now })
        .where(
          and(
            eq(pageSectionsTable.page_id, page.id),
            eq(pageSectionsTable.id, BigInt(id)),
          ),
        );
    }
    return ok({ ok: true });
  }

  // ---- helpers -------------------------------------------------------

  private validatePage(body: unknown, ignore?: bigint) {
    return laravelValidate(this.db, body, {
      name: ['required', 'string', 'max:160'],
      slug: [
        'nullable',
        'string',
        'max:120',
        'regex:/^[a-z0-9\\-]+$/',
        `unique:pages,slug,${ignore ?? 'NULL'}`,
      ],
      template: ['nullable', 'string', 'max:40'],
      status: ['required', 'in:draft,published'],
      meta_title: ['nullable', 'string', 'max:180'],
      meta_description: ['nullable', 'string', 'max:320'],
      meta_keywords: ['nullable', 'string', 'max:320'],
      og_image: ['nullable', 'string', 'max:255'],
      schema: ['nullable', 'string'],
      noindex: ['nullable', 'boolean'],
      sort_order: ['nullable', 'integer', 'min:0', 'max:9999'],
    });
  }

  /** PageController::payload(). A missing `slug` key is an undefined-index error (500) in legacy. */
  private payload(data: Data) {
    if (!('slug' in data)) throw new Error('Undefined array key "slug"');
    const slug = data.slug as string | null;
    return {
      name: data.name as string,
      slug: slug || strSlug(data.name as string),
      template: (data.template as string | null | undefined) ?? 'default',
      status: data.status as string,
      meta_title: (data.meta_title as string | null | undefined) ?? null,
      meta_description:
        (data.meta_description as string | null | undefined) ?? null,
      meta_keywords: (data.meta_keywords as string | null | undefined) ?? null,
      og_image: (data.og_image as string | null | undefined) ?? null,
      schema: jsonField(data.schema),
      noindex: bool(data.noindex ?? false),
      sort_order: Math.trunc(Number(data.sort_order ?? 0)) || 0,
    };
  }

  /** PageController::validateSection() + fillSection(). */
  private async fillSection(
    section: page_sections | null,
    raw: unknown,
    files: MulterFile[],
  ) {
    const file = files.find((f) => f.fieldname === 'media_file');
    const data = await validateWithFiles(
      this.db,
      raw,
      {
        type: ['required', `in:${Object.keys(SECTION_TYPES).join(',')}`],
        key: ['nullable', 'string', 'max:60'],
        eyebrow: ['nullable', 'string', 'max:160'],
        heading: ['nullable', 'string', 'max:255'],
        subheading: ['nullable', 'string', 'max:500'],
        body: ['nullable', 'string'],
        media_url: ['nullable', 'string', 'max:255'],
        media_file: ['nullable'],
        data: ['nullable', 'string'],
        is_active: ['nullable', 'boolean'],
      },
      { media_file: file },
      [{ field: 'media_file', kind: 'image', maxKb: 10240 }],
    );

    let mediaUrl =
      (data.media_url as string | null | undefined) ??
      section?.media_url ??
      null;
    if (file) {
      await this.storage.delete(section?.media_url);
      mediaUrl = await storeOrReject('media_file', () =>
        this.storage.storeCloud(file, 'image'),
      );
    }
    const pick = (k: string) => (data[k] as string | null | undefined) ?? null;
    return {
      type: data.type as string,
      key: pick('key'),
      eyebrow: pick('eyebrow'),
      heading: pick('heading'),
      subheading: pick('subheading'),
      body: pick('body'),
      media_url: mediaUrl,
      data: jsonField(data.data),
      // `(bool) ($data['is_active'] ?? $section->is_active ?? true)`.
      is_active: bool(data.is_active ?? section?.is_active ?? true),
    };
  }
}
