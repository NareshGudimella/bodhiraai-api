import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { dirtyFields } from '../common/http/eloquent';
import { phpJsonDecode, phpJsonEncode, sameJson } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { site_settings } from '../db/schema';

/**
 * Port of App\Services\Cms\SettingsService: global settings stored one per
 * row in `site_settings`, scalars wrapped as {"_": value}, read as a flat
 * "group.key" => value map.
 */
@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.db.query.site_settings.findMany({
      orderBy: [asc(site_settings.id)],
    });
    return Object.fromEntries(
      rows.map((s) => [
        `${s.group}.${s.key}`,
        unwrap(s.value === null ? null : phpJsonDecode(s.value)),
      ]),
    );
  }

  async get(key: string, fallback: unknown = null) {
    return (await this.all())[key] ?? fallback;
  }

  /** Bulk upsert ['group.key' => value] (updateOrCreate per pair). */
  async setMany(pairs: Record<string, unknown>) {
    for (const [compound, value] of Object.entries(pairs)) {
      const at = compound.indexOf('.');
      const group = compound.slice(0, at);
      const key = compound.slice(at + 1);
      const encoded = phpJsonEncode(wrap(value));
      const now = new Date();
      const row = await this.db.query.site_settings.findFirst({
        where: and(eq(site_settings.group, group), eq(site_settings.key, key)),
        orderBy: [asc(site_settings.id)],
      });
      if (!row) {
        await this.db.insert(site_settings).values({
          group,
          key,
          value: encoded,
          created_at: now,
          updated_at: now,
        });
      } else if (!sameJson(row.value, encoded)) {
        await this.db
          .update(site_settings)
          .set({ ...dirtyFields(row, { value: encoded }), updated_at: now })
          .where(eq(site_settings.id, row.id));
      }
    }
  }
}

function wrap(value: unknown) {
  return Array.isArray(value) || (value !== null && typeof value === 'object')
    ? value
    : { _: value };
}

function unwrap(value: unknown) {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    '_' in value
  ) {
    return value._;
  }
  return value;
}
