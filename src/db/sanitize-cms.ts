/**
 * security: not in legacy. `npm run cms:sanitize`: re-sanitises the CMS HTML already in the
 * database (blog post bodies, page section bodies, the `contact.map_embed` setting) with the
 * allowlist the API now applies on save (`cms/sanitize.ts`). Idempotent (only rows that change
 * are written; a second run reports 0) and prints counts only, never content.
 */
import { loadEnv } from '../config/env';
loadEnv();
import { and, eq } from 'drizzle-orm';
import { phpJsonEncode } from '../common/http/laravel';
import { HTML_SETTINGS, sanitizeCms } from '../cms/sanitize';
import { createDb, type Db } from './db';
import { blog_posts, page_sections, site_settings } from './schema';

export async function sanitizeCmsRows(db: Db) {
  const counts = { posts: 0, sections: 0, settings: 0 };

  for (const p of await db
    .select({ id: blog_posts.id, body: blog_posts.body })
    .from(blog_posts)) {
    if (p.body === null) continue;
    const body = sanitizeCms(p.body);
    if (body === p.body) continue;
    await db.update(blog_posts).set({ body }).where(eq(blog_posts.id, p.id));
    counts.posts++;
  }

  for (const s of await db
    .select({ id: page_sections.id, body: page_sections.body })
    .from(page_sections)) {
    if (s.body === null) continue;
    const body = sanitizeCms(s.body);
    if (body === s.body) continue;
    await db
      .update(page_sections)
      .set({ body })
      .where(eq(page_sections.id, s.id));
    counts.sections++;
  }

  for (const [compound, clean] of Object.entries(HTML_SETTINGS)) {
    if (!clean) continue;
    const at = compound.indexOf('.');
    const rows = await db
      .select({ id: site_settings.id, value: site_settings.value })
      .from(site_settings)
      .where(
        and(
          eq(site_settings.group, compound.slice(0, at)),
          eq(site_settings.key, compound.slice(at + 1)),
        ),
      );
    for (const r of rows) {
      let wrapped: unknown;
      try {
        wrapped = JSON.parse(r.value ?? 'null');
      } catch {
        continue;
      }
      const html = (wrapped as { _?: unknown } | null)?._;
      if (typeof html !== 'string') continue;
      const value = clean(html);
      if (value === html) continue;
      await db
        .update(site_settings)
        .set({ value: phpJsonEncode({ _: value }) })
        .where(eq(site_settings.id, r.id));
      counts.settings++;
    }
  }
  return counts;
}

async function main() {
  const db = createDb();
  try {
    const c = await sanitizeCmsRows(db);
    console.log(
      `CMS sanitised: ${c.posts} post(s), ${c.sections} section(s), ${c.settings} setting(s) changed.`,
    );
  } finally {
    await db.$client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
