process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';
import { redisThrottlerStorage } from '../src/common/http/redis-throttler-storage';
import { DB, type Db } from '../src/db/db';
import {
  chapters,
  lessons,
  schools,
  site_settings,
  subjects,
} from '../src/db/schema';
import type { site_settings as SiteSetting } from '../src/db/types';

loadEnv();

const tag = randomBytes(3).toString('hex');
const VDO_SECRET = `stub-${tag}`;
const hex32 = () => randomBytes(16).toString('hex');

/**
 * Gap fixes (2026-11-01), security: not in legacy.
 * - /video/otp signs only marketing videos: VDOCIPHER_VIDEO_ID, the
 *   `media.home_video_id` setting and VDOCIPHER_PUBLIC_VIDEO_IDS, never a
 *   lesson's video. VdoCipher is a local stub (VDOCIPHER_API_BASE).
 * - /health reports Redis as down (503 degraded) when REDIS_URL is unreachable.
 * Creates one school, subject, chapter and lesson, and sets
 * `media.home_video_id`; all restored afterwards.
 */
describe('Gap fixes (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let stub: Server;
  const otpCalls: string[] = [];
  const envBefore: Record<string, string | undefined> = {};
  let schoolId: bigint | null = null;
  let homeSettingBefore: SiteSetting | undefined;
  const http = () => request(app.getHttpServer());

  const defaultId = hex32();
  const homeId = hex32();
  const extraId = hex32();
  const lessonId = hex32();
  const strangerId = hex32();

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const otp = (id: string) => http().get(`/api/v1/video/otp?video=${id}`);

  beforeAll(async () => {
    stub = createServer((req: IncomingMessage, res) => {
      req.resume();
      req.on('end', () => {
        const json = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (req.headers.authorization !== `Apisecret ${VDO_SECRET}`)
          return json(403, { message: 'bad secret' });
        const m = /^\/videos\/([a-f0-9]{32})\/otp$/.exec(req.url ?? '');
        if (req.method === 'POST' && m) {
          otpCalls.push(m[1]);
          return json(200, { otp: `otp-${tag}`, playbackInfo: `pbi-${tag}` });
        }
        return json(404, { message: 'no route' });
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    setEnv('VDOCIPHER_API_SECRET', VDO_SECRET);
    setEnv('VDOCIPHER_API_BASE', base);
    setEnv('VDOCIPHER_VIDEO_ID', defaultId);
    // Upper case and spaces: compared case-insensitively, trimmed.
    setEnv(
      'VDOCIPHER_PUBLIC_VIDEO_IDS',
      ` ${extraId.toUpperCase()} , ${lessonId}`,
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);

    const now = new Date();
    homeSettingBefore = await db.query.site_settings.findFirst({
      where: and(
        eq(site_settings.group, 'media'),
        eq(site_settings.key, 'home_video_id'),
      ),
    });
    if (homeSettingBefore) {
      await db
        .update(site_settings)
        .set({ value: JSON.stringify({ _: homeId }) })
        .where(eq(site_settings.id, homeSettingBefore.id));
    } else {
      await db.insert(site_settings).values({
        group: 'media',
        key: 'home_video_id',
        value: JSON.stringify({ _: homeId }),
        created_at: now,
        updated_at: now,
      });
    }

    const [school] = await db
      .insert(schools)
      .values({
        name: `Gap ${tag}`,
        slug: `gap-${tag}`,
        code: `GAP${tag.toUpperCase()}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    schoolId = school.id;
    const [subject] = await db
      .insert(subjects)
      .values({
        school_id: school.id,
        name: `Gap ${tag}`,
        slug: `gap-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    const [chapter] = await db
      .insert(chapters)
      .values({
        subject_id: subject.id,
        title: 'Chapter',
        slug: `gap-chapter-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    // A lesson video that is also (wrongly) on the public allowlist.
    await db.insert(lessons).values({
      chapter_id: chapter.id,
      title: 'Lesson',
      slug: `gap-lesson-${tag}`,
      type: 'video',
      video_id: lessonId.toUpperCase(),
      created_at: now,
      updated_at: now,
    });
  });

  afterAll(async () => {
    // Before REDIS_URL is restored: the storage the health check created.
    redisThrottlerStorage()?.onApplicationShutdown();
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (db) {
      if (homeSettingBefore) {
        await db
          .update(site_settings)
          .set({ value: homeSettingBefore.value })
          .where(eq(site_settings.id, homeSettingBefore.id));
      } else {
        await db
          .delete(site_settings)
          .where(
            and(
              eq(site_settings.group, 'media'),
              eq(site_settings.key, 'home_video_id'),
            ),
          );
      }
      if (schoolId !== null) {
        // chapters and lessons cascade from the subject
        await db.delete(subjects).where(eq(subjects.school_id, schoolId));
        await db.delete(schools).where(eq(schools.id, schoolId));
      }
    }
    await app?.close();
    await new Promise((r) => stub?.close(r));
  });

  describe('/video/otp', () => {
    it('signs the default, home-page and allowlisted marketing videos', async () => {
      for (const id of [defaultId, homeId, extraId]) {
        const res = await otp(id).expect(200);
        expect(res.body).toEqual({
          otp: `otp-${tag}`,
          playbackInfo: `pbi-${tag}`,
        });
      }
      // No ?video= means VDOCIPHER_VIDEO_ID, as legacy.
      await http().get('/api/v1/video/otp').expect(200);
      expect(otpCalls).toEqual([defaultId, homeId, extraId, defaultId]);
    });

    it('refuses any other id, and lesson videos even when allowlisted, like an invalid id', async () => {
      otpCalls.length = 0;
      for (const id of [strangerId, lessonId, lessonId.toUpperCase()]) {
        const res = await otp(id).expect(422);
        expect(res.body).toEqual({ error: 'invalid_video_id' });
      }
      expect(otpCalls).toEqual([]);
    });
  });

  describe('/health', () => {
    it('reports Redis as down (503 degraded) when REDIS_URL is unreachable', async () => {
      // Created on first use by the health check (the throttler was built without it).
      setEnv('REDIS_URL', 'redis://127.0.0.1:1');
      const res = await http().get('/health').expect(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.checks.db.status).toBe('ok');
      expect(res.body.checks.redis).toEqual({ status: 'down' });
    });
  });
});
