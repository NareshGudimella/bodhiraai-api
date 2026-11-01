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
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { ok } from '../common/http/api-response';
import { dirtyFields, toModel } from '../common/http/eloquent';
import { modelNotFound, parseLaravelDate, toStr } from '../common/http/laravel';
import { pageFrom, pageMeta } from '../common/http/paginate';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { myDesc } from '../db/helpers';
import {
  blog_categories,
  blog_post_tag,
  blog_posts as postsTable,
  tags as tagsTable,
} from '../db/schema';
import type { blog_posts, users } from '../db/types';
import { strSlug } from '../storage/laravel-str';
import { StorageService } from '../storage/storage.service';
import {
  storeOrReject,
  uploadOptions,
  validateWithFiles,
} from '../storage/uploads';
import { AuditService, CMS_MODEL } from './audit.service';
import type { MulterFile } from './cms-resource.controller';

type Data = Record<string, unknown>;
const bool = (v: unknown) =>
  !(
    v === null ||
    v === undefined ||
    v === false ||
    v === 0 ||
    v === '' ||
    v === '0'
  );

/** Port of App\Http\Controllers\Cms\PostController. Posts bind by slug. */
@Controller('cms/posts')
@Roles(Role.SuperAdmin, Role.WebAdmin)
export class CmsPostsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private async post(slug: string) {
    const post = await this.db.query.blog_posts.findFirst({
      where: and(eq(postsTable.slug, slug), isNull(postsTable.deleted_at)),
      orderBy: [asc(postsTable.id)],
    });
    if (!post) throw modelNotFound('Cms\\BlogPost', slug);
    return post;
  }

  private subject(id: bigint) {
    return { type: CMS_MODEL('BlogPost'), id };
  }

  @Get()
  async index(
    @Query('status') status: unknown,
    @Query('category') category: unknown,
    @Query('page') rawPage: unknown,
  ) {
    const where = and(
      isNull(postsTable.deleted_at),
      status ? eq(postsTable.status, toStr(status)) : undefined,
      category
        ? inArray(
            postsTable.blog_category_id,
            this.db
              .select({ id: blog_categories.id })
              .from(blog_categories)
              .where(eq(blog_categories.slug, toStr(category))),
          )
        : undefined,
    );
    const page = pageFrom(rawPage);
    const [total, rows] = await Promise.all([
      this.db.$count(postsTable, where),
      this.db.query.blog_posts.findMany({
        where,
        orderBy: [myDesc(postsTable.created_at), asc(postsTable.id)],
        offset: (page - 1) * 15,
        limit: 15,
        with: {
          blog_categories: true,
          users: { columns: { id: true, name: true } },
        },
      }),
    ]);
    return ok(
      rows.map(({ blog_categories: c, users: a, ...p }) =>
        toModel('blog_posts', p, {
          category: c ? toModel('blog_categories', c) : null,
          author: a ? { id: a.id, name: a.name } : null,
        }),
      ),
      null,
      pageMeta(page, 15, total),
    );
  }

  /** Categories and existing tags for the post form. */
  @Get('options')
  async options() {
    const [categories, tags] = await Promise.all([
      this.db.query.blog_categories.findMany({
        orderBy: [asc(blog_categories.name), asc(blog_categories.id)],
      }),
      this.db.query.tags.findMany({
        orderBy: [asc(tagsTable.name), asc(tagsTable.id)],
      }),
    ]);
    return ok({
      categories: categories.map((c) => toModel('blog_categories', c)),
      tags: tags.map((t) => toModel('tags', t)),
    });
  }

  @Get(':post')
  async edit(@Param('post') slug: string) {
    const post = await this.post(slug);
    const tags = await this.db.query.tags.findMany({
      where: inArray(
        tagsTable.id,
        this.db
          .select({ id: blog_post_tag.tag_id })
          .from(blog_post_tag)
          .where(eq(blog_post_tag.blog_post_id, post.id)),
      ),
      orderBy: [asc(tagsTable.id)],
    });
    return ok(
      toModel('blog_posts', post, {
        tags: tags.map((t) => toModel('tags', t)),
      }),
    );
  }

  @Post()
  @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 1)))
  async store(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Body() body: unknown,
    @UploadedFiles() files: MulterFile[] = [],
  ) {
    const data = await this.validatePost(body, files);
    const values = await this.fill(null, data, files);
    const now = new Date();
    const [post] = await this.db
      .insert(postsTable)
      .values({
        author_id: user.id,
        ...values,
        created_at: now,
        updated_at: now,
      } as blog_posts)
      .returning();
    await this.syncTags(post.id, data);
    await this.audit.log(
      user,
      client,
      'cms.post.created',
      this.subject(post.id),
    );
    return ok({ slug: post.slug }, 'Post saved.');
  }

  @Patch(':post')
  @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 1)))
  async update(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('post') slug: string,
    @Body() body: unknown,
    @UploadedFiles() files: MulterFile[] = [],
  ) {
    const post = await this.post(slug);
    const data = await this.validatePost(body, files, post.id);
    const values = await this.fill(post, data, files);
    const changed = dirtyFields(post, values);
    if (Object.keys(changed).length) {
      await this.db
        .update(postsTable)
        .set({ ...changed, updated_at: new Date() })
        .where(eq(postsTable.id, post.id));
    }
    await this.syncTags(post.id, data);
    await this.audit.log(
      user,
      client,
      'cms.post.updated',
      this.subject(post.id),
    );
    return ok({ slug: values.slug }, 'Post updated.');
  }

  @Delete(':post')
  async destroy(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Param('post') slug: string,
  ) {
    const post = await this.post(slug);
    const now = new Date();
    await this.db
      .update(postsTable)
      .set({ deleted_at: now, updated_at: now })
      .where(eq(postsTable.id, post.id));
    await this.audit.log(
      user,
      client,
      'cms.post.deleted',
      this.subject(post.id),
    );
    return ok(null, 'Post deleted.');
  }

  private validatePost(body: unknown, files: MulterFile[], ignore?: bigint) {
    const cover = files.find((f) => f.fieldname === 'cover_file');
    return validateWithFiles(
      this.db,
      body,
      {
        title: ['required', 'string', 'max:200'],
        slug: [
          'nullable',
          'string',
          'max:220',
          'regex:/^[a-z0-9\\-]+$/',
          `unique:blog_posts,slug,${ignore ?? 'NULL'}`,
        ],
        blog_category_id: ['nullable', 'exists:blog_categories,id'],
        excerpt: ['nullable', 'string', 'max:500'],
        body: ['nullable', 'string'],
        cover_image_url: ['nullable', 'string', 'max:255'],
        cover_file: ['nullable'],
        status: ['required', 'in:draft,scheduled,published'],
        published_at: ['nullable', 'date'],
        is_featured: ['nullable', 'boolean'],
        reading_minutes: ['nullable', 'integer', 'min:0', 'max:240'],
        meta_title: ['nullable', 'string', 'max:180'],
        meta_description: ['nullable', 'string', 'max:320'],
        og_image: ['nullable', 'string', 'max:255'],
        tags: ['nullable', 'string'],
      },
      { cover_file: cover },
      [{ field: 'cover_file', kind: 'image', maxKb: 10240 }],
    );
  }

  /** PostController::fill(). A missing `slug` key is an undefined-index error (500) in legacy. */
  private async fill(post: blog_posts | null, data: Data, files: MulterFile[]) {
    let cover =
      (data.cover_image_url as string | null | undefined) ??
      post?.cover_image_url ??
      null;
    const file = files.find((f) => f.fieldname === 'cover_file');
    if (file) {
      await this.storage.delete(post?.cover_image_url);
      cover = await storeOrReject('cover_file', () =>
        this.storage.storeCloud(file, 'image'),
      );
    }

    // Published with no explicit date → now. Scheduled keeps the future date.
    let publishedAt: Date | null =
      typeof data.published_at === 'string'
        ? (parseLaravelDate(data.published_at)?.stored ?? null)
        : null;
    if (data.status === 'published' && !publishedAt) publishedAt = new Date();

    if (!('slug' in data)) throw new Error('Undefined array key "slug"');
    const pick = (k: string) => (data[k] as string | null | undefined) ?? null;
    return {
      title: data.title as string,
      slug: (data.slug as string | null) || strSlug(data.title as string),
      blog_category_id:
        data.blog_category_id === null || data.blog_category_id === undefined
          ? null
          : BigInt(toStr(data.blog_category_id)),
      excerpt: pick('excerpt'),
      body: pick('body'),
      cover_image_url: cover,
      status: data.status as string,
      published_at: publishedAt,
      is_featured: bool(data.is_featured ?? false),
      reading_minutes: Math.trunc(Number(data.reading_minutes ?? 0)) || 0,
      meta_title: pick('meta_title'),
      meta_description: pick('meta_description'),
      og_image: pick('og_image'),
    };
  }

  /**
   * PostController::syncTags(): comma-separated names, firstOrCreate by slug,
   * then sync. An empty tags box (null after ConvertEmptyStringsToNull)
   * clears the post's tags. Fixed legacy bug: legacy passed that null to a
   * `string` parameter, a 500 after the post was saved.
   */
  private async syncTags(postId: bigint, data: Data) {
    const raw = data.tags ?? '';
    const names = [
      ...new Set(
        toStr(raw)
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t !== '' && t !== '0'),
      ),
    ];
    const ids: bigint[] = [];
    for (const name of names) {
      const slug = strSlug(name);
      let tag = await this.db.query.tags.findFirst({
        where: eq(tagsTable.slug, slug),
        orderBy: [asc(tagsTable.id)],
      });
      if (!tag) {
        const now = new Date();
        [tag] = await this.db
          .insert(tagsTable)
          .values({ slug, name, created_at: now, updated_at: now })
          .returning();
      }
      if (!ids.includes(tag.id)) ids.push(tag.id);
    }
    const current = await this.db.query.blog_post_tag.findMany({
      where: eq(blog_post_tag.blog_post_id, postId),
      orderBy: [asc(blog_post_tag.tag_id)],
    });
    const have = current.map((r) => r.tag_id);
    const detach = have.filter((id) => !ids.includes(id));
    if (detach.length) {
      await this.db
        .delete(blog_post_tag)
        .where(
          and(
            eq(blog_post_tag.blog_post_id, postId),
            inArray(blog_post_tag.tag_id, detach),
          ),
        );
    }
    for (const id of ids.filter((i) => !have.includes(i))) {
      await this.db
        .insert(blog_post_tag)
        .values({ blog_post_id: postId, tag_id: id });
    }
  }
}
