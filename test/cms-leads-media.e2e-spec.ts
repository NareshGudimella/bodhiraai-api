process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, inArray, like, sql } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  audit_logs,
  demo_requests,
  media,
  media_folders,
  newsletter_subscribers,
  personal_access_tokens,
  users,
} from '../src/db/schema';

loadEnv();

const tag = randomBytes(3).toString('hex');

/** Minimal RFC 4180 reader (PHP fputcsv output): rows of fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) rows.push([...row, field]);
  return rows;
}

/**
 * CMS lead management (demo requests, newsletter subscribers with CSV export)
 * and the media library (uploads, folders) with STORAGE_DRIVER=local into a
 * temporary LOCAL_UPLOAD_DIR. Signs in a web admin made for the test; every
 * demo request, subscriber, media row, folder and audit row it makes is
 * removed afterwards.
 */
describe('CMS leads and media (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let uploadDir: string;
  const envBefore: Record<string, string | undefined> = {};
  const createdUsers: bigint[] = [];
  const t: Record<string, string> = {};
  const demoIds: bigint[] = [];
  const subscriberIds: bigint[] = [];
  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeAll(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'bodhira-cms-'));
    setEnv('STORAGE_DRIVER', 'local');
    setEnv('LOCAL_UPLOAD_DIR', uploadDir);
    setEnv('PUBLIC_URL', 'http://api.e2e.test');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    const tokens = app.get(TokenService);
    const now = new Date();

    for (const [who, role] of [
      ['web', 'web_admin'],
      ['content', 'content_manager'],
      ['admin', 'admin'],
    ] as const) {
      const [user] = await db
        .insert(users)
        .values({
          name: `Cms ${who} ${tag}`,
          email: `cms-${tag}-${who}@bodhira.test`,
          password: 'x',
          role,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .returning();
      createdUsers.push(user.id);
      t[who] = await tokens.issue(user, 'e2e', [`role:${role}`]);
    }

    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    const demos = await db
      .insert(demo_requests)
      .values([
        {
          type: 'school',
          name: `School Lead ${tag}`,
          email: `lead1-${tag}@example.test`,
          phone: '9000000001',
          organization: 'Green, Valley "High"',
          message: 'Line one',
          status: 'new',
          created_at: ago(3),
          updated_at: ago(3),
        },
        {
          type: 'school',
          name: `Second ${tag}`,
          email: `lead2-${tag}@example.test`,
          phone: '9000000002',
          status: 'contacted',
          created_at: ago(2),
          updated_at: ago(2),
        },
        {
          type: 'student',
          name: `Student Lead ${tag}`,
          email: `lead3-${tag}@example.test`,
          phone: '9000000003',
          grade: '9',
          status: 'new',
          created_at: ago(1),
          updated_at: ago(1),
        },
      ])
      .returning();
    demoIds.push(...demos.map((d) => d.id));
    const subs = await db
      .insert(newsletter_subscribers)
      .values([
        {
          email: `sub1-${tag}@example.test`,
          name: `Asha ${tag}`,
          status: 'subscribed',
          created_at: new Date('2026-05-04T10:11:12Z'),
          updated_at: now,
        },
        {
          email: `sub2-${tag}@example.test`,
          name: null,
          status: 'unsubscribed',
          created_at: ago(1),
          updated_at: now,
        },
      ])
      .returning();
    subscriberIds.push(...subs.map((s) => s.id));
  });

  afterAll(async () => {
    if (db) {
      if (demoIds.length)
        await db
          .delete(demo_requests)
          .where(inArray(demo_requests.id, demoIds));
      if (subscriberIds.length)
        await db
          .delete(newsletter_subscribers)
          .where(inArray(newsletter_subscribers.id, subscriberIds));
      // Anything a failed run left behind under this tag.
      await db.delete(media).where(like(media.original_name, `%${tag}%`));
      await db
        .delete(media_folders)
        .where(like(media_folders.name, `%${tag}%`));
      if (createdUsers.length) {
        await db
          .delete(audit_logs)
          .where(inArray(audit_logs.user_id, createdUsers));
        await db
          .delete(personal_access_tokens)
          .where(inArray(personal_access_tokens.tokenable_id, createdUsers));
        await db.delete(users).where(inArray(users.id, createdUsers));
      }
    }
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app?.close();
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  const count = async (q: ReturnType<typeof sql>) =>
    (await db.execute<{ n: number }>(q)).rows[0].n;

  // ── Demo requests ──

  it('lists demo requests by type with counts from SQL', async () => {
    const { body } = await http()
      .get('/api/v1/cms/demos?type=student')
      .set(as('web'))
      .expect(200);
    expect(Object.keys(body.data)).toEqual(['demos', 'type', 'counts']);
    expect(body.data.type).toBe('student');
    expect(body.data.counts).toEqual({
      school: await count(
        sql`select count(*)::int as n from demo_requests where type = 'school'`,
      ),
      student: await count(
        sql`select count(*)::int as n from demo_requests where type = 'student'`,
      ),
    });
    expect(body.meta).toEqual(
      expect.objectContaining({
        current_page: 1,
        per_page: 20,
        total: body.data.counts.student,
      }),
    );
    expect(
      body.data.demos.every((d: { type: string }) => d.type === 'student'),
    ).toBe(true);
    expect(body.data.demos.map((d: { id: number }) => BigInt(d.id))).toContain(
      demoIds[2],
    );

    // Unknown type falls back to school; status filters.
    const school = await http()
      .get('/api/v1/cms/demos?type=wizard&status=contacted')
      .set(as('web'))
      .expect(200);
    expect(school.body.data.type).toBe('school');
    expect(school.body.meta.total).toBe(
      await count(
        sql`select count(*)::int as n from demo_requests where type = 'school' and status = 'contacted'`,
      ),
    );
    expect(
      school.body.data.demos.every(
        (d: { status: string }) => d.status === 'contacted',
      ),
    ).toBe(true);
    expect(
      school.body.data.demos.map((d: { id: number }) => BigInt(d.id)),
    ).toContain(demoIds[1]);
  });

  it('keeps leads to super and web admins', async () => {
    await http().get('/api/v1/cms/demos').set(as('content')).expect(403);
    await http().get('/api/v1/cms/subscribers').set(as('admin')).expect(403);
    await http().get('/api/v1/cms/subscribers/export').expect(401);
  });

  it('updates and deletes a demo request with binding and validation', async () => {
    const id = demoIds[0];
    const bad = await http()
      .patch(`/api/v1/cms/demos/${id}`)
      .set(as('web'))
      .send({ status: 'won' })
      .expect(422);
    expect(bad.body.errors).toEqual({
      status: ['The selected status is invalid.'],
    });
    const missing = await http()
      .patch('/api/v1/cms/demos/99999999')
      .set(as('web'))
      .send({ status: 'won' })
      .expect(404);
    expect(missing.body.message).toBe(
      'No query results for model [App\\Models\\Cms\\DemoRequest] 99999999',
    );
    const ok = await http()
      .patch(`/api/v1/cms/demos/${id}`)
      .set(as('web'))
      .send({ status: 'scheduled' })
      .expect(200);
    expect(ok.body.message).toBe('Demo request updated.');
    const row = await db.query.demo_requests.findFirst({
      where: eq(demo_requests.id, id),
    });
    expect(row!.status).toBe('scheduled');

    const toDelete = demoIds[1];
    await http()
      .delete(`/api/v1/cms/demos/${toDelete}`)
      .set(as('web'))
      .expect(200);
    expect(
      await db.query.demo_requests.findFirst({
        where: eq(demo_requests.id, toDelete),
      }),
    ).toBeUndefined();
  });

  it('exports demo requests as CSV, one row per SQL row', async () => {
    const res = await http()
      .get('/api/v1/cms/demos/export?type=school')
      .set(as('web'))
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="school-demo-requests.csv"',
    );
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      'Type',
      'Name',
      'Email',
      'Phone',
      'City',
      'Board',
      'Organization',
      'Designation',
      'Students',
      'Class',
      'Message',
      'Status',
      'Received',
    ]);
    expect(rows.length - 1).toBe(
      await count(
        sql`select count(*)::int as n from demo_requests where type = 'school'`,
      ),
    );
    const mine = rows.find((r) => r[2] === `lead1-${tag}@example.test`)!;
    expect(mine[6]).toBe('Green, Valley "High"');
    expect(mine[11]).toBe('scheduled');
    expect(mine[12]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    // fputcsv quoting on the wire.
    expect(res.text).toContain('"Green, Valley ""High"""');

    const all = await http()
      .get('/api/v1/cms/demos/export')
      .set(as('web'))
      .expect(200);
    expect(all.headers['content-disposition']).toBe(
      'attachment; filename="all-demo-requests.csv"',
    );
    expect(parseCsv(all.text).length - 1).toBe(
      await count(sql`select count(*)::int as n from demo_requests`),
    );
  });

  // ── Newsletter ──

  it('lists subscribers with Laravel meta and a status filter', async () => {
    const { body } = await http()
      .get('/api/v1/cms/subscribers')
      .set(as('web'))
      .expect(200);
    expect(body.meta).toEqual(
      expect.objectContaining({
        current_page: 1,
        per_page: 30,
        total: await count(
          sql`select count(*)::int as n from newsletter_subscribers`,
        ),
      }),
    );
    const sub = body.data.find(
      (s: { id: number }) => BigInt(s.id) === subscriberIds[0],
    );
    expect(sub).toEqual(
      expect.objectContaining({
        email: `sub1-${tag}@example.test`,
        status: 'subscribed',
        created_at: '2026-05-04T10:11:12.000000Z',
      }),
    );
    const unsub = await http()
      .get('/api/v1/cms/subscribers?status=unsubscribed')
      .set(as('web'))
      .expect(200);
    expect(unsub.body.meta.total).toBe(
      await count(
        sql`select count(*)::int as n from newsletter_subscribers where status = 'unsubscribed'`,
      ),
    );
    expect(
      unsub.body.data.every(
        (s: { status: string }) => s.status === 'unsubscribed',
      ),
    ).toBe(true);
  });

  it('exports subscribers as CSV with headers, content type and SQL row count', async () => {
    const res = await http()
      .get('/api/v1/cms/subscribers/export')
      .set(as('web'))
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="newsletter-subscribers.csv"',
    );
    expect(res.text.split('\n')[0]).toBe('Email,Name,Status,Subscribed');
    expect(res.text.endsWith('\n')).toBe(true);
    const rows = parseCsv(res.text);
    expect(rows.length - 1).toBe(
      await count(sql`select count(*)::int as n from newsletter_subscribers`),
    );
    // A name with a space is quoted; a null name is an empty field.
    expect(res.text).toContain(
      `sub1-${tag}@example.test,"Asha ${tag}",subscribed,"2026-05-04 10:11:12"\n`,
    );
    expect(
      rows.find((r) => r[0] === `sub2-${tag}@example.test`)!.slice(1, 3),
    ).toEqual(['', 'unsubscribed']);
  });

  it('removes a subscriber', async () => {
    const id = subscriberIds[1];
    const res = await http()
      .delete(`/api/v1/cms/subscribers/${id}`)
      .set(as('web'))
      .expect(200);
    expect(res.body.message).toBe('Subscriber removed.');
    expect(
      await db.query.newsletter_subscribers.findFirst({
        where: eq(newsletter_subscribers.id, id),
      }),
    ).toBeUndefined();
    await http()
      .delete(`/api/v1/cms/subscribers/${id}`)
      .set(as('web'))
      .expect(404);
  });

  // ── Media ──

  let folderId: bigint;

  it('creates media folders with validation', async () => {
    const bad = await http()
      .post('/api/v1/cms/media-folders')
      .set(as('web'))
      .send({ name: '', parent_id: 99999999 })
      .expect(422);
    expect(bad.body.errors).toEqual({
      name: ['The name field is required.'],
      parent_id: ['The selected parent id is invalid.'],
    });
    const res = await http()
      .post('/api/v1/cms/media-folders')
      .set(as('web'))
      .send({ name: `Banners ${tag}` })
      .expect(201);
    expect(res.body.message).toBe('Folder created.');
    const folder = (await db.query.media_folders.findFirst({
      where: eq(media_folders.name, `Banners ${tag}`),
    }))!;
    expect(folder.slug).toBe(`banners-${tag}`);
    expect(folder.parent_id).toBeNull();
    folderId = folder.id;
  });

  it('rejects uploads that are missing or not images', async () => {
    const before = await db.$count(media);
    const none = await http()
      .post('/api/v1/cms/media')
      .set(as('web'))
      .field('media_folder_id', '99999999')
      .expect(422);
    expect(none.body.errors).toEqual({
      files: ['The files field is required.'],
      media_folder_id: ['The selected media folder id is invalid.'],
    });
    const text = await http()
      .post('/api/v1/cms/media')
      .set(as('web'))
      .attach('files', Buffer.from('just some text'), `notes-${tag}.png`)
      .expect(422);
    expect(text.body.errors).toEqual({
      'files.0': ['The files.0 field must be an image.'],
    });
    expect(await db.$count(media)).toBe(before);
  });

  let mediaId: bigint;
  let storedPath: string;

  it('uploads an image into a folder and lists it', async () => {
    const png = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: { r: 200, g: 10, b: 10 },
      },
    })
      .png()
      .toBuffer();
    const res = await http()
      .post('/api/v1/cms/media')
      .set(as('web'))
      .field('media_folder_id', String(folderId))
      .attach('files', png, `hero_banner-${tag}.png`)
      .expect(201);
    expect(res.body.message).toBe('Media uploaded.');

    const row = (await db.query.media.findFirst({
      where: eq(media.original_name, `hero_banner-${tag}.png`),
    }))!;
    mediaId = row.id;
    expect(row).toEqual(
      expect.objectContaining({
        media_folder_id: folderId,
        disk: 'cloud',
        mime: 'image/png',
        size: BigInt(png.length),
        width: 3,
        height: 2,
      }),
    );
    // Str::headline of the name without its extension.
    expect(row.alt).toMatch(/^Hero Banner \S+$/);
    expect(row.url).toMatch(
      new RegExp(
        `^http://api\\.e2e\\.test/uploads/cloud/\\d{4}/\\d\\d/\\d\\d/hero-banner-${tag}-[A-Za-z0-9]{8}\\.png$`,
      ),
    );
    expect(row.path).toBe(row.url);
    storedPath = join(uploadDir, row.url.replace(/^.*\/uploads\//, ''));
    expect(existsSync(storedPath)).toBe(true);

    const audit = await db
      .select()
      .from(audit_logs)
      .where(inArray(audit_logs.user_id, createdUsers));
    expect(audit.map((a) => a.action)).toContain('cms.media.uploaded');

    const list = await http()
      .get(`/api/v1/cms/media?folder=${folderId}`)
      .set(as('web'))
      .expect(200);
    expect(Object.keys(list.body.data)).toEqual([
      'folders',
      'active_folder',
      'media',
    ]);
    expect(BigInt(list.body.data.active_folder.id)).toBe(folderId);
    expect(list.body.meta).toEqual(
      expect.objectContaining({ per_page: 24, total: 1 }),
    );
    expect(BigInt(list.body.data.media[0].id)).toBe(mediaId);
    expect(
      list.body.data.folders.map((f: { id: number }) => BigInt(f.id)),
    ).toContain(folderId);
  });

  it('deletes the media file and row, then the folder', async () => {
    await http()
      .delete(`/api/v1/cms/media/${mediaId}`)
      .set(as('web'))
      .expect(200);
    expect(
      await db.query.media.findFirst({ where: eq(media.id, mediaId) }),
    ).toBeUndefined();
    expect(existsSync(storedPath)).toBe(false);
    await http()
      .delete(`/api/v1/cms/media/${mediaId}`)
      .set(as('web'))
      .expect(404);

    await http()
      .delete(`/api/v1/cms/media-folders/${folderId}`)
      .set(as('web'))
      .expect(200);
    const missing = await http()
      .delete(`/api/v1/cms/media-folders/${folderId}`)
      .set(as('web'))
      .expect(404);
    expect(missing.body.message).toBe(
      `No query results for model [App\\Models\\Cms\\MediaFolder] ${folderId}`,
    );
  });
});
