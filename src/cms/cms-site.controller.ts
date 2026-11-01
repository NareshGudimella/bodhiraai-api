import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import sharp from 'sharp';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { ApiException, ValidationFailed } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { dirtyFields, toModel } from '../common/http/eloquent';
import {
  modelNotFound,
  requestBoolean,
  requestFilled,
  routeId,
  toStr,
} from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { cleanInput } from '../common/http/transform-request.middleware';
import { pageFrom, pageMeta } from '../common/http/paginate';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { myDesc } from '../db/helpers';
import {
  blog_posts,
  contact_messages,
  media as mediaTable,
  media_folders,
  menu_items,
  navigation_menus,
  newsletter_subscribers,
  pages as pagesTable,
  services as servicesTable,
  student_enquiries,
  testimonials as testimonialsTable,
} from '../db/schema';
import type { users } from '../db/types';
import { strHeadline, strSlug } from '../storage/laravel-str';
import { StorageService } from '../storage/storage.service';
import { sniff } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFiles,
} from '../storage/uploads';
import { AuditService, CMS_MODEL } from './audit.service';
import type { MulterFile } from './cms-resource.controller';
import { SETTINGS_SCHEMA } from './cms.schema';
import { SettingsService } from './settings.service';

type Data = Record<string, unknown>;

const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** PHP `(int)` on request input. */
const phpInt = (v: unknown) => {
  if (typeof v === 'number') return Math.trunc(v);
  const m = /^\s*[+-]?\d+/.exec(toStr(v));
  return m ? Number(m[0]) : 0;
};

/**
 * Ports of the CMS dashboard (Cms\DashboardController), global settings
 * (Cms\SettingsController), menus (Cms\MenuController) and the media library
 * (Cms\MediaController).
 */
@Controller('cms')
@Roles(Role.SuperAdmin, Role.WebAdmin)
export class CmsSiteController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  async dashboard() {
    const db = this.db;
    const [
      pages,
      posts,
      newMessages,
      subscribers,
      services,
      testimonials,
      enquiries,
      messages,
      recentPosts,
    ] = await Promise.all([
      db.$count(
        pagesTable,
        and(eq(pagesTable.status, 'published'), isNull(pagesTable.deleted_at)),
      ),
      db.$count(blog_posts, isNull(blog_posts.deleted_at)),
      db.$count(contact_messages, eq(contact_messages.status, 'new')),
      db.$count(
        newsletter_subscribers,
        eq(newsletter_subscribers.status, 'subscribed'),
      ),
      db.$count(servicesTable, isNull(servicesTable.deleted_at)),
      db.$count(testimonialsTable, isNull(testimonialsTable.deleted_at)),
      db.$count(student_enquiries),
      db.query.contact_messages.findMany({
        orderBy: [
          myDesc(contact_messages.created_at),
          asc(contact_messages.id),
        ],
        limit: 6,
      }),
      db.query.blog_posts.findMany({
        where: isNull(blog_posts.deleted_at),
        orderBy: [myDesc(blog_posts.created_at), asc(blog_posts.id)],
        limit: 6,
        with: { blog_categories: true },
      }),
    ]);
    return ok({
      stats: [
        { label: 'Published pages', value: pages, href: '/cms/pages' },
        { label: 'Blog posts', value: posts, href: '/cms/posts' },
        { label: 'New messages', value: newMessages, href: '/cms/contacts' },
        { label: 'Subscribers', value: subscribers, href: '/cms/subscribers' },
      ],
      content: [
        { label: 'Services', value: services, href: '/cms/services' },
        {
          label: 'Testimonials',
          value: testimonials,
          href: '/cms/testimonials',
        },
        {
          label: 'Student enquiries',
          value: enquiries,
          href: '/super/enquiries',
        },
      ],
      recent_messages: messages.map((m) => toModel('contact_messages', m)),
      recent_posts: recentPosts.map(({ blog_categories: c, ...post }) =>
        toModel('blog_posts', post, {
          category: c ? toModel('blog_categories', c) : null,
        }),
      ),
    });
  }

  // ---- Settings ------------------------------------------------------

  @Get('settings')
  async settingsIndex() {
    return ok({ schema: SETTINGS_SCHEMA, values: await this.settings.all() });
  }

  @Post('settings/:group')
  @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 4)))
  async settingsUpdate(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('group') group: string,
    @Body() raw: unknown,
    @UploadedFiles() files: MulterFile[] = [],
  ) {
    const schema = SETTINGS_SCHEMA[group];
    if (!schema) throw new ApiException('HTTP error', 404);
    const input = (cleanInput(raw) ?? {}) as Data;

    const pairs: Data = {};
    for (const field of schema.fields) {
      const { key, type } = field;
      const compound = `${group}.${key}`;
      if (type === 'image') {
        const file = files.find((f) => f.fieldname === `${key}_file`);
        if (file) {
          await validateWithFiles(
            this.db,
            {},
            { [`${key}_file`]: ['nullable'] },
            { [`${key}_file`]: file },
            [{ field: `${key}_file`, kind: 'image', maxKb: 10240 }],
          );
          await this.storage.delete(
            (await this.settings.get(compound)) as string | null,
          );
          pairs[compound] = await storeOrReject(`${key}_file`, () =>
            this.storage.storeCloud(file, 'image'),
          );
        } else if (requestFilled(input[key])) {
          pairs[compound] = input[key];
        }
        continue;
      }
      pairs[compound] =
        type === 'boolean'
          ? requestBoolean(input[key])
          : type === 'number'
            ? phpInt(input[key] ?? 0)
            : (input[key] ?? null);
    }

    await this.settings.setMany(pairs);
    await this.audit.log(user, client, 'cms.settings.updated', null, { group });
    return ok(null, `${ucfirst(group)} settings saved.`);
  }

  // ---- Menus ---------------------------------------------------------

  /** Route binding by key. */
  private async menu(key: string) {
    const menu = await this.db.query.navigation_menus.findFirst({
      where: eq(navigation_menus.key, key),
      orderBy: [asc(navigation_menus.id)],
    });
    if (!menu) throw modelNotFound('Cms\\NavigationMenu', key);
    return menu;
  }

  private async menuItem(raw: string) {
    const id = routeId(raw, 'Cms\\MenuItem');
    const item = await this.db.query.menu_items.findFirst({
      where: eq(menu_items.id, id),
    });
    if (!item) throw modelNotFound('Cms\\MenuItem', id);
    return item;
  }

  @Get('menus')
  async menus(@Query('menu') key: unknown) {
    const menus = await this.db.query.navigation_menus.findMany({
      orderBy: [asc(navigation_menus.name), asc(navigation_menus.id)],
    });
    const active = key ? menus.find((m) => m.key === key) : menus[0];
    const items = active
      ? await this.db.query.menu_items.findMany({
          where: and(
            eq(menu_items.navigation_menu_id, active.id),
            isNull(menu_items.parent_id),
          ),
          orderBy: [asc(menu_items.sort_order), asc(menu_items.id)],
          with: {
            other_menu_items: {
              orderBy: (t) => [asc(t.sort_order), asc(t.id)],
            },
          },
        })
      : [];
    return ok({
      menus: menus.map((m) => toModel('navigation_menus', m)),
      active: active ? toModel('navigation_menus', active) : null,
      items: items.map(({ other_menu_items: children, ...i }) =>
        toModel('menu_items', i, {
          children: children.map((c) => toModel('menu_items', c)),
        }),
      ),
    });
  }

  private validateItem(body: unknown) {
    return laravelValidate(this.db, body, {
      label: ['required', 'string', 'max:120'],
      url: ['required', 'string', 'max:255'],
      target: ['nullable', 'in:_self,_blank'],
      icon: ['nullable', 'string', 'max:60'],
      parent_id: ['nullable', 'exists:menu_items,id'],
      is_active: ['nullable', 'boolean'],
    });
  }

  /** Validated item attributes as Eloquent would store them (booleans cast). */
  private itemFields(data: Data) {
    const out: Data = { ...data };
    if ('is_active' in out && out.is_active !== null)
      out.is_active = requestBoolean(out.is_active);
    if ('parent_id' in out && out.parent_id !== null)
      out.parent_id = BigInt(toStr(out.parent_id));
    return out;
  }

  @Post('menus/:menu/items')
  async itemStore(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('menu') key: string,
    @Body() body: unknown,
  ) {
    const menu = await this.menu(key);
    const data = this.itemFields(await this.validateItem(body));
    const [last] = await this.db
      .select({ sort_order: max(menu_items.sort_order) })
      .from(menu_items)
      .where(eq(menu_items.navigation_menu_id, menu.id));
    const now = new Date();
    await this.db.insert(menu_items).values({
      ...(data as { label: string; url: string }),
      navigation_menu_id: menu.id,
      sort_order: (last.sort_order ?? -1) + 1,
      created_at: now,
      updated_at: now,
    });
    await this.audit.log(user, client, 'cms.menu.item.created', {
      type: CMS_MODEL('NavigationMenu'),
      id: menu.id,
    });
    return ok(null, 'Menu item added.');
  }

  @Patch('menu-items/:item')
  async itemUpdate(@Param('item') raw: string, @Body() body: unknown) {
    const item = await this.menuItem(raw);
    const changed = dirtyFields(
      item,
      this.itemFields(await this.validateItem(body)),
    );
    if (Object.keys(changed).length) {
      await this.db
        .update(menu_items)
        .set({ ...changed, updated_at: new Date() })
        .where(eq(menu_items.id, item.id));
    }
    return ok(null, 'Menu item updated.');
  }

  @Delete('menu-items/:item')
  async itemDestroy(@Param('item') raw: string) {
    const item = await this.menuItem(raw);
    await this.db.delete(menu_items).where(eq(menu_items.id, item.id));
    return ok(null, 'Menu item removed.');
  }

  @Post('menus/:menu/reorder')
  async reorder(@Param('menu') key: string, @Body() body: unknown) {
    const menu = await this.menu(key);
    const data = await laravelValidate(this.db, body, {
      ids: ['required', 'array'],
      'ids.*': ['integer'],
    });
    const now = new Date();
    for (const [i, id] of (
      Object.values(data.ids as object) as (string | number)[]
    ).entries()) {
      await this.db
        .update(menu_items)
        .set({ sort_order: i, updated_at: now })
        .where(
          and(
            eq(menu_items.navigation_menu_id, menu.id),
            eq(menu_items.id, BigInt(id)),
          ),
        );
    }
    return ok({ ok: true });
  }

  // ---- Media ---------------------------------------------------------

  @Get('media')
  async media(
    @Query('folder') folder: unknown,
    @Query('page') rawPage: unknown,
  ) {
    const folders = await this.db.query.media_folders.findMany({
      orderBy: [asc(media_folders.name), asc(media_folders.id)],
    });
    const active = folder
      ? (folders.find((f) => f.id === BigInt(phpInt(folder))) ?? null)
      : null;
    const where = active
      ? eq(mediaTable.media_folder_id, active.id)
      : undefined;
    const page = pageFrom(rawPage);
    const [total, rows] = await Promise.all([
      this.db.$count(mediaTable, where),
      this.db.query.media.findMany({
        where,
        orderBy: [myDesc(mediaTable.created_at), asc(mediaTable.id)],
        offset: (page - 1) * 24,
        limit: 24,
      }),
    ]);
    return ok(
      {
        folders: folders.map((f) => toModel('media_folders', f)),
        active_folder: active ? toModel('media_folders', active) : null,
        media: rows.map((m) => toModel('media', m)),
      },
      null,
      pageMeta(page, 24, total),
    );
  }

  @Post('media')
  @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 20)))
  async mediaStore(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Body() raw: unknown,
    @UploadedFiles() files: MulterFile[] = [],
  ) {
    const uploads = files.filter(
      (f) => f.fieldname === 'files' || f.fieldname === 'files[]',
    );
    const errors: Record<string, string[]> = {};
    if (!uploads.length) errors.files = ['The files field is required.'];
    let body: Data = {};
    try {
      body = await laravelValidate(this.db, cleanInput(raw), {
        media_folder_id: ['nullable', 'exists:media_folders,id'],
      });
    } catch (e) {
      if (!(e instanceof ValidationFailed)) throw e;
      Object.assign(
        errors,
        (e.getResponse() as { errors: Record<string, string[]> }).errors,
      );
    }
    // files.* → image, max:10240 (wildcard keys come last, as in Laravel).
    for (const [i, f] of uploads.entries()) {
      const msgs: string[] = [];
      if (!['jpeg', 'png', 'gif', 'webp', 'bmp'].includes(sniff(f.buffer))) {
        msgs.push(`The files.${i} field must be an image.`);
      }
      if (f.size > 10240 * 1024)
        msgs.push(
          `The files.${i} field must not be greater than 10240 kilobytes.`,
        );
      if (msgs.length) errors[`files.${i}`] = msgs;
    }
    if (Object.keys(errors).length) throw new ValidationFailed(errors);

    const folderId =
      body.media_folder_id === null || body.media_folder_id === undefined
        ? null
        : BigInt(toStr(body.media_folder_id));
    for (const file of uploads) {
      const url = await storeOrReject('files', () =>
        this.storage.storeCloud(file, 'image'),
      );
      const meta = await sharp(file.buffer)
        .metadata()
        .catch(() => null);
      const now = new Date();
      await this.db.insert(mediaTable).values({
        media_folder_id: folderId,
        disk: 'cloud',
        path: url.replace(/^\/+/, ''),
        url,
        mime: (file as MulterFile & { mimetype?: string }).mimetype ?? null,
        // Fixed legacy bug: MediaController::store read the size after the
        // file had moved, so every upload answered 500 without a row.
        size: BigInt(file.size),
        width: meta?.width || null,
        height: meta?.height || null,
        original_name: file.originalname,
        alt: strHeadline(file.originalname.replace(/\.[^.]*$/, '')),
        created_at: now,
        updated_at: now,
      });
    }
    await this.audit.log(user, client, 'cms.media.uploaded');
    return ok(null, 'Media uploaded.');
  }

  private async medium(raw: string) {
    const id = routeId(raw, 'Cms\\Media');
    const m = await this.db.query.media.findFirst({
      where: eq(mediaTable.id, id),
    });
    if (!m) throw modelNotFound('Cms\\Media', id);
    return m;
  }

  @Patch('media/:medium')
  async mediaUpdate(@Param('medium') raw: string, @Body() body: unknown) {
    const m = await this.medium(raw);
    const data = await laravelValidate(this.db, body, {
      alt: ['nullable', 'string', 'max:255'],
      title: ['nullable', 'string', 'max:255'],
      media_folder_id: ['nullable', 'exists:media_folders,id'],
    });
    if ('media_folder_id' in data && data.media_folder_id !== null) {
      data.media_folder_id = BigInt(toStr(data.media_folder_id));
    }
    const changed = dirtyFields(m, data);
    if (Object.keys(changed).length) {
      await this.db
        .update(mediaTable)
        .set({ ...changed, updated_at: new Date() })
        .where(eq(mediaTable.id, m.id));
    }
    return ok(null, 'Media details saved.');
  }

  @Delete('media/:medium')
  async mediaDestroy(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('medium') raw: string,
  ) {
    const m = await this.medium(raw);
    await this.storage.delete(m.url);
    await this.db.delete(mediaTable).where(eq(mediaTable.id, m.id));
    await this.audit.log(user, client, 'cms.media.deleted', {
      type: CMS_MODEL('Media'),
      id: m.id,
    });
    return ok(null, 'Media deleted.');
  }

  @Post('media-folders')
  async folderStore(@Body() body: unknown) {
    const data = await laravelValidate(this.db, body, {
      name: ['required', 'string', 'max:120'],
      parent_id: ['nullable', 'exists:media_folders,id'],
    });
    const now = new Date();
    await this.db.insert(media_folders).values({
      name: data.name as string,
      ...('parent_id' in data
        ? {
            parent_id:
              data.parent_id === null ? null : BigInt(toStr(data.parent_id)),
          }
        : {}),
      slug: strSlug(data.name as string),
      created_at: now,
      updated_at: now,
    });
    return ok(null, 'Folder created.');
  }

  @Delete('media-folders/:folder')
  async folderDestroy(@Param('folder') raw: string) {
    const id = routeId(raw, 'Cms\\MediaFolder');
    const folder = await this.db.query.media_folders.findFirst({
      where: eq(media_folders.id, id),
    });
    if (!folder) throw modelNotFound('Cms\\MediaFolder', id);
    await this.db.delete(media_folders).where(eq(media_folders.id, id));
    return ok(null, 'Folder deleted.');
  }
}
