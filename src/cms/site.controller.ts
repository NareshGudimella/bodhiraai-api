import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Public } from '../common/decorators/auth.decorators';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { toModel } from '../common/http/eloquent';
import { modelNotFound } from '../common/http/laravel';
import { pageFrom, pageMeta } from '../common/http/paginate';
import { DB, type Db } from '../db/db';
import { countOf, myDesc } from '../db/helpers';
import {
  blog_categories,
  blog_post_tag,
  blog_posts,
  faqs,
  features,
  menu_items,
  navigation_menus,
  pages,
  services,
  social_links,
  tags,
  team_members,
  testimonials,
} from '../db/schema';
import { SettingsService } from './settings.service';
import { SiteImagesService } from './site-images.service';

/** BlogPost::live(): published and past its publish time. */
const LIVE = () =>
  and(
    eq(blog_posts.status, 'published'),
    isNotNull(blog_posts.published_at),
    lte(blog_posts.published_at, new Date()),
    isNull(blog_posts.deleted_at),
  );

/** BlogPost::live() for a correlated count (countOf's child-column form). */
const liveCount = (c: (column: string) => SQL) =>
  sql`${c('status')} = 'published' and ${c('published_at')} is not null and ${c('published_at')} <= ${new Date().toISOString()} and ${c('deleted_at')} is null`;

/** Newest live posts first. */
const NEWEST = [myDesc(blog_posts.published_at), desc(blog_posts.id)];

/**
 * Data for the public marketing site (Phase 6b). Legacy rendered these in
 * Blade: the layout's view composer (menus, social links, recent posts, the
 * page's SEO record), the inline queries in home/about/features/teachers,
 * and PageController's blog, FAQ and success-story pages.
 */
@Controller('site')
@Public()
export class SiteController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly images: SiteImagesService,
  ) {}

  /** The layout's chrome for one page path (AppServiceProvider's `layouts.app` composer). */
  @Get('chrome')
  async chrome(@Query('path') rawPath: unknown) {
    const slug =
      (typeof rawPath === 'string' ? rawPath : '').replace(/^\/+|\/+$/g, '') ||
      'home';
    const db = this.db;
    const menu = (key: string) =>
      db.query.navigation_menus.findFirst({
        where: eq(navigation_menus.key, key),
        orderBy: [asc(navigation_menus.id)],
      });
    const [header, footer, social, recent, seo, settings, images] =
      await Promise.all([
        menu('header'),
        menu('footer_primary'),
        db.query.social_links.findMany({
          where: eq(social_links.is_active, true),
          orderBy: [asc(social_links.sort_order), asc(social_links.id)],
        }),
        db.query.blog_posts.findMany({
          where: LIVE(),
          orderBy: NEWEST,
          limit: 2,
        }),
        db.query.pages.findFirst({
          where: and(eq(pages.slug, slug), isNull(pages.deleted_at)),
          orderBy: [asc(pages.id)],
        }),
        this.settings.all(),
        this.images.overrides(),
      ]);
    const items = (menuId: bigint | undefined, rootOnly: boolean) =>
      menuId === undefined
        ? Promise.resolve([])
        : db.query.menu_items.findMany({
            where: and(
              eq(menu_items.navigation_menu_id, menuId),
              eq(menu_items.is_active, true),
              rootOnly ? isNull(menu_items.parent_id) : undefined,
            ),
            orderBy: [asc(menu_items.sort_order), asc(menu_items.id)],
          });
    const [headerItems, footerItems] = await Promise.all([
      items(header?.id, true),
      items(footer?.id, false),
    ]);
    return ok({
      settings,
      header_menu: headerItems.map((i) => toModel('menu_items', i)),
      footer_menu: footerItems.map((i) => toModel('menu_items', i)),
      social: social.map((s) => toModel('social_links', s)),
      recent_posts: recent.map((b) => toModel('blog_posts', b)),
      seo: seo ? toModel('pages', seo) : null,
      images,
    });
  }

  /** The active team, testimonials, features and services, in sort order (the marketing pages' inline queries). */
  @Get('collections')
  async collections() {
    const db = this.db;
    const [teamRows, testimonialRows, featureRows, serviceRows] =
      await Promise.all([
        db.query.team_members.findMany({
          where: and(
            eq(team_members.is_active, true),
            isNull(team_members.deleted_at),
          ),
          orderBy: [asc(team_members.sort_order), asc(team_members.id)],
        }),
        db.query.testimonials.findMany({
          where: and(
            eq(testimonials.is_active, true),
            isNull(testimonials.deleted_at),
          ),
          orderBy: [asc(testimonials.sort_order), asc(testimonials.id)],
        }),
        db.query.features.findMany({
          where: eq(features.is_active, true),
          orderBy: [asc(features.sort_order), asc(features.id)],
        }),
        db.query.services.findMany({
          where: and(eq(services.is_active, true), isNull(services.deleted_at)),
          orderBy: [asc(services.sort_order), asc(services.id)],
        }),
      ]);
    return ok({
      team: teamRows.map((r) => toModel('team_members', r)),
      testimonials: testimonialRows.map((r) => toModel('testimonials', r)),
      features: featureRows.map((r) => toModel('features', r)),
      services: serviceRows.map((r) => toModel('services', r)),
    });
  }

  /** PageController::faq(): active FAQs grouped by category ("General" when blank). */
  @Get('faqs')
  async faqs() {
    const rows = await this.db.query.faqs.findMany({
      where: eq(faqs.is_active, true),
      orderBy: [asc(faqs.sort_order), asc(faqs.id)],
    });
    const grouped: Record<string, unknown[]> = {};
    for (const f of rows)
      (grouped[f.category || 'General'] ??= []).push(toModel('faqs', f));
    return ok({ grouped });
  }

  /** PageController::blogIndex(): live posts (9 a page, optional category), the featured one, categories with live counts. */
  @Get('blog')
  async blog(
    @Query('category') category: unknown,
    @Query('page') rawPage: unknown,
  ) {
    const where = and(
      LIVE(),
      typeof category === 'string' && category
        ? inArray(
            blog_posts.blog_category_id,
            this.db
              .select({ id: blog_categories.id })
              .from(blog_categories)
              .where(eq(blog_categories.slug, category)),
          )
        : undefined,
    );
    const page = pageFrom(rawPage);
    const db = this.db;
    const [total, posts, featured, categories] = await Promise.all([
      db.$count(blog_posts, where),
      db.query.blog_posts.findMany({
        where,
        orderBy: NEWEST,
        offset: (page - 1) * 9,
        limit: 9,
        with: { blog_categories: true },
      }),
      db.query.blog_posts.findFirst({
        where: and(LIVE(), eq(blog_posts.is_featured, true)),
        orderBy: NEWEST,
      }),
      db.query.blog_categories.findMany({
        where: eq(blog_categories.is_active, true),
        orderBy: [asc(blog_categories.sort_order), asc(blog_categories.id)],
        extras: (t) => ({
          posts_count: countOf(
            blog_posts,
            'blog_category_id',
            t.id,
            liveCount,
          ).as('posts_count'),
        }),
      }),
    ]);
    return ok(
      {
        posts: posts.map(({ blog_categories: c, ...b }) =>
          toModel('blog_posts', b, {
            category: c ? toModel('blog_categories', c) : null,
          }),
        ),
        featured: featured ? toModel('blog_posts', featured) : null,
        categories: categories.map(({ posts_count, ...c }) =>
          toModel('blog_categories', c, { posts_count }),
        ),
      },
      null,
      pageMeta(page, 9, total),
    );
  }

  /**
   * Whether /blog/{slug} would show a post, without counting a view. The web
   * proxy asks before rendering, so a missing post gets a real 404 status.
   */
  @Get('blog/:slug/exists')
  async postExists(@Param('slug') slug: string) {
    const live = await this.db.$count(
      blog_posts,
      and(LIVE(), eq(blog_posts.slug, slug)),
    );
    if (!live) throw modelNotFound('Cms\\BlogPost', slug);
    return ok({ exists: true });
  }

  /** PageController::blogShow(): a live post (views + 1, as legacy's increment), and 3 related. */
  @Get('blog/:slug')
  async post(@Param('slug') slug: string) {
    const post = await this.db.query.blog_posts.findFirst({
      where: and(eq(blog_posts.slug, slug), isNull(blog_posts.deleted_at)),
      orderBy: [asc(blog_posts.id)],
      with: {
        blog_categories: true,
        users: { columns: { id: true, name: true } },
      },
    });
    if (!post) throw modelNotFound('Cms\\BlogPost', slug);
    if (
      post.status !== 'published' ||
      !post.published_at ||
      post.published_at.getTime() > Date.now()
    ) {
      throw new ApiException('HTTP error', 404);
    }
    // $post->increment('views'): one UPDATE that also touches updated_at.
    await this.db
      .update(blog_posts)
      .set({ views: sql`${blog_posts.views} + 1`, updated_at: new Date() })
      .where(eq(blog_posts.id, post.id));
    const [postTags, related] = await Promise.all([
      this.db.query.tags.findMany({
        where: inArray(
          tags.id,
          this.db
            .select({ id: blog_post_tag.tag_id })
            .from(blog_post_tag)
            .where(eq(blog_post_tag.blog_post_id, post.id)),
        ),
        orderBy: [asc(tags.id)],
      }),
      this.db.query.blog_posts.findMany({
        where: and(
          LIVE(),
          ne(blog_posts.id, post.id),
          post.blog_category_id
            ? eq(blog_posts.blog_category_id, post.blog_category_id)
            : undefined,
        ),
        orderBy: NEWEST,
        limit: 3,
      }),
    ]);
    const { blog_categories: c, users: author, ...row } = post;
    return ok({
      post: toModel(
        'blog_posts',
        { ...row, views: row.views + 1 },
        {
          category: c ? toModel('blog_categories', c) : null,
          author: author ? { id: author.id, name: author.name } : null,
          tags: postTags.map((t) => toModel('tags', t)),
        },
      ),
      related: related.map((r) => toModel('blog_posts', r)),
    });
  }

  /** PageController::successStories(): live posts in the "success-stories" category (all live posts if it doesn't exist). */
  @Get('success-stories')
  async successStories(@Query('page') rawPage: unknown) {
    const category = await this.db.query.blog_categories.findFirst({
      where: eq(blog_categories.slug, 'success-stories'),
      orderBy: [asc(blog_categories.id)],
    });
    const where = and(
      LIVE(),
      category ? eq(blog_posts.blog_category_id, category.id) : undefined,
    );
    const page = pageFrom(rawPage);
    const [total, stories] = await Promise.all([
      this.db.$count(blog_posts, where),
      this.db.query.blog_posts.findMany({
        where,
        orderBy: NEWEST,
        offset: (page - 1) * 9,
        limit: 9,
        with: { blog_categories: true },
      }),
    ]);
    return ok(
      {
        category: category ? toModel('blog_categories', category) : null,
        stories: stories.map(({ blog_categories: c, ...b }) =>
          toModel('blog_posts', b, {
            category: c ? toModel('blog_categories', c) : null,
          }),
        ),
      },
      null,
      pageMeta(page, 9, total),
    );
  }
}
