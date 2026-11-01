import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Type,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { and, asc, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { ok } from '../common/http/api-response';
import { dirtyFields, toModel } from '../common/http/eloquent';
import {
  modelNotFound,
  requestBoolean,
  requestFilled,
  routeId,
  toStr,
} from '../common/http/laravel';
import type { Rules } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { columnNamed, tableNamed } from '../db/helpers';
import type { users } from '../db/types';
import { strSlug } from '../storage/laravel-str';
import { StorageService } from '../storage/storage.service';
import type { IncomingFile } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFiles,
} from '../storage/uploads';
import { AuditService, CMS_MODEL } from './audit.service';
import { RESOURCES, type ResourceDef } from './cms.schema';

type Row = Record<string, unknown> & { id: bigint };
export type MulterFile = IncomingFile & { fieldname: string };

/**
 * Port of App\Http\Controllers\Cms\CmsResourceController: schema-driven CRUD
 * for one simple content collection (services, FAQs, team, …). One Nest
 * controller is generated per collection at `/cms/<slug>`.
 */
function resourceController(slug: string, def: ResourceDef): Type<unknown> {
  @Controller(`cms/${slug}`)
  @Roles(Role.SuperAdmin, Role.WebAdmin)
  class CmsResourceController {
    constructor(
      @Inject(DB) readonly db: Db,
      readonly storage: StorageService,
      readonly audit: AuditService,
    ) {}

    readonly table = tableNamed(def.table);

    col(name: string) {
      return columnNamed(this.table, name);
    }

    get live(): SQL | undefined {
      return def.softDeletes ? isNull(this.col('deleted_at')) : undefined;
    }

    byId(id: bigint) {
      return eq(this.col('id'), id);
    }

    /** `$m::findOrFail($id)` (soft-deleted rows don't match). */
    async find(raw: string) {
      const id = routeId(raw, `Cms\\${def.model}`);
      const [row] = (await this.db
        .select()
        .from(this.table)
        .where(and(this.byId(id), this.live))
        .limit(1)) as Row[];
      if (!row) throw modelNotFound(`Cms\\${def.model}`, id);
      return row;
    }

    async updateRow(id: bigint, data: Record<string, unknown>) {
      await this.db.update(this.table).set(data).where(this.byId(id));
    }

    serialize(row: Row) {
      return toModel(def.table, row);
    }

    meta() {
      return {
        fields: def.fields,
        labels: def.labels,
        toggleable: def.fields.some((f) => f.name === 'is_active'),
      };
    }

    @Get()
    async index() {
      const rows = (await this.db
        .select()
        .from(this.table)
        .where(this.live)
        .orderBy(asc(this.col('sort_order')), desc(this.col('id')))) as Row[];
      return ok({ rows: rows.map((r) => this.serialize(r)), ...this.meta() });
    }

    @Get(':id')
    async show(@Param('id') raw: string) {
      return ok({ row: this.serialize(await this.find(raw)), ...this.meta() });
    }

    @Post()
    @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 4)))
    async store(
      @CurrentUser() user: users,
      @Client() client: ClientInfo,
      @Body() body: unknown,
      @UploadedFiles() files: MulterFile[] = [],
    ) {
      const values = await this.fill(null, body, files);
      const now = new Date();
      const [row] = (await this.db
        .insert(this.table)
        .values({ ...values, created_at: now, updated_at: now })
        .returning()) as Row[];
      await this.audit.log(user, client, `${def.routeBase}.created`, {
        type: CMS_MODEL(def.model),
        id: row.id,
      });
      return ok({ id: row.id }, `${def.labels[0]} created.`);
    }

    @Patch(':id')
    @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 4)))
    async update(
      @CurrentUser() user: users,
      @Client() client: ClientInfo,
      @Param('id') raw: string,
      @Body() body: unknown,
      @UploadedFiles() files: MulterFile[] = [],
    ) {
      const row = await this.find(raw);
      const changed = dirtyFields(row, await this.fill(row, body, files));
      if (Object.keys(changed).length) {
        await this.updateRow(row.id, { ...changed, updated_at: new Date() });
      }
      await this.audit.log(user, client, `${def.routeBase}.updated`, {
        type: CMS_MODEL(def.model),
        id: row.id,
      });
      return ok({ id: row.id }, `${def.labels[0]} updated.`);
    }

    @Delete(':id')
    async destroy(
      @CurrentUser() user: users,
      @Client() client: ClientInfo,
      @Param('id') raw: string,
    ) {
      const row = await this.find(raw);
      if (def.softDeletes) {
        const now = new Date();
        await this.updateRow(row.id, { deleted_at: now, updated_at: now });
      } else {
        await this.db.delete(this.table).where(this.byId(row.id));
      }
      await this.audit.log(user, client, `${def.routeBase}.deleted`, {
        type: CMS_MODEL(def.model),
        id: row.id,
      });
      return ok(null, `${def.labels[0]} deleted.`);
    }

    @Post(':id/toggle')
    async toggle(@Param('id') raw: string) {
      const row = await this.find(raw);
      const active = !row.is_active;
      await this.updateRow(row.id, {
        is_active: active,
        updated_at: new Date(),
      });
      return ok(
        { is_active: active },
        active
          ? `${def.labels[0]} is now visible.`
          : `${def.labels[0]} hidden.`,
      );
    }

    /** CmsResourceController::fill(): validate, then each schema field's value by type. */
    async fill(row: Row | null, raw: unknown, files: MulterFile[]) {
      const rules: Rules = {};
      const fileRules = [];
      for (const f of def.fields) {
        rules[f.name] = f.rules;
        if (f.type === 'image') {
          // Placeholder keeps the file field's place in Laravel's error order.
          rules[`${f.name}_file`] = ['nullable'];
          fileRules.push({
            field: `${f.name}_file`,
            kind: 'image' as const,
            maxKb: 10240,
          });
        }
      }
      const byField = Object.fromEntries(files.map((f) => [f.fieldname, f]));
      const body = await validateWithFiles(
        this.db,
        raw,
        rules,
        byField,
        fileRules,
      );
      // The cleaned input (trimmed, '' → null), as $request->input() sees it.
      const input = (k: string) => (body[k] === undefined ? null : body[k]);

      const out: Record<string, unknown> = {};
      for (const f of def.fields) {
        let value: unknown;
        switch (f.type) {
          case 'boolean':
            value = requestBoolean(input(f.name));
            break;
          case 'number':
            value = requestFilled(input(f.name))
              ? Math.trunc(Number(input(f.name)))
              : 0;
            break;
          case 'image': {
            const file = byField[`${f.name}_file`];
            if (file) {
              await this.storage.delete(row?.[f.name] as string | null);
              value = await storeOrReject(`${f.name}_file`, () =>
                this.storage.storeCloud(file, 'image'),
              );
            } else {
              value = requestFilled(input(f.name))
                ? input(f.name)
                : (row?.[f.name] ?? null);
            }
            break;
          }
          default:
            value = input(f.name);
        }
        // Auto-slug when a slug field is empty (from title or name).
        if (f.name === 'slug' && (!value || value === '0')) {
          const source = input('title') || input('name');
          if (source) value = strSlug(toStr(source));
        }
        out[f.name] = value;
      }
      return out;
    }
  }
  Object.defineProperty(CmsResourceController, 'name', {
    value: `Cms${slug[0].toUpperCase()}${slug.slice(1)}Controller`,
  });
  return CmsResourceController;
}

export const RESOURCE_CONTROLLERS = Object.entries(RESOURCES).map(
  ([slug, def]) => resourceController(slug, def),
);
