import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { phpJsonDecode } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { site_settings } from '../db/schema';

/** site_settings group holding replaced theme images: key = web path, value = {"_": url}. */
export const SITE_IMAGES_GROUP = 'site_images';

/**
 * Curated "main images" of the public site (legacy SiteImageController::MAIN).
 * Content managers may replace only these.
 */
export const MAIN_IMAGES: Record<string, { path: string; label: string }[]> = {
  Brand: [
    {
      path: 'assets/img/logo/bodhira-logo-light.png',
      label: 'Logo (header — light, on maroon)',
    },
    { path: 'assets/img/logo/bodhira-logo.png', label: 'Logo (dark variant)' },
    { path: 'assets/img/favicon.png', label: 'Favicon' },
  ],
  Hero: [
    {
      path: 'assets/img/portrait-happy-cute-little-indian-260nw-2542824705.jpg',
      label: 'Hero image',
    },
    { path: 'assets/img/images/hero-author-1.png', label: 'Hero avatar 1' },
    { path: 'assets/img/images/hero-author-2.png', label: 'Hero avatar 2' },
    { path: 'assets/img/images/hero-author-3.png', label: 'Hero avatar 3' },
    { path: 'assets/img/images/hero-author-4.png', label: 'Hero avatar 4' },
  ],
  'About & Promo': [
    { path: 'assets/img/images/about-img-1.jpg', label: 'About image 1' },
    { path: 'assets/img/images/about-img-2.jpg', label: 'About image 2' },
    { path: 'assets/img/images/promo-img-1.png', label: 'Promo image 1' },
    { path: 'assets/img/images/promo-img-2.png', label: 'Promo image 2' },
    { path: 'assets/img/images/promo-img-3.png', label: 'Promo image 3' },
    {
      path: 'assets/img/images/req-photo.jpg',
      label: '"Set Up Your School" photo',
    },
  ],
  'Content & Courses': [
    { path: 'assets/img/images/content-img-1.png', label: 'Content image 1' },
    { path: 'assets/img/images/content-img-2.png', label: 'Content image 2' },
    { path: 'assets/img/images/content-img-3.png', label: 'Content image 3' },
    { path: 'assets/img/images/course-img-1.png', label: 'Course image 1' },
    { path: 'assets/img/images/course-img-2.png', label: 'Course image 2' },
    { path: 'assets/img/images/course-img-3.png', label: 'Course image 3' },
  ],
  Team: [1, 2, 3, 4].map((n) => ({
    path: `assets/img/team/team-${n}.png`,
    label: `Team member ${n}`,
  })),
  Footer: [
    { path: 'assets/img/images/footer-post-1.png', label: 'Footer post 1' },
    { path: 'assets/img/images/footer-post-2.png', label: 'Footer post 2' },
  ],
};

/** Curated site videos (legacy SiteImageController::VIDEOS). */
export const SITE_VIDEOS = [
  {
    path: 'assets/Nationalism_of_india_Chapter_01_v01 (1).mp4',
    label: 'Home — "About" demo video',
    rec: 'MP4 · 1280×720 (16:9) · keep under ~50 MB',
  },
];

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

@Injectable()
export class SiteImagesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Replaced files: web path → URL. */
  async overrides(): Promise<Record<string, string>> {
    const rows = await this.db.query.site_settings.findMany({
      where: eq(site_settings.group, SITE_IMAGES_GROUP),
      orderBy: [asc(site_settings.id)],
    });
    const out: Record<string, string> = {};
    for (const r of rows) {
      const v =
        r.value === null
          ? null
          : (phpJsonDecode(r.value) as { _?: unknown } | null);
      if (v && typeof v._ === 'string') out[r.key] = v._;
    }
    return out;
  }
}
