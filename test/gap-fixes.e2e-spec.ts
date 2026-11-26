process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';
import { redisThrottlerStorage } from '../src/common/http/redis-throttler-storage';

loadEnv();

/**
 * Gap fixes (2026-11-01), security: not in legacy.
 * - /health reports Redis as down (503 degraded) when REDIS_URL is unreachable.
 * (The /video/otp marketing-video checks went with VdoCipher, 2026-11-27.)
 */
describe('Gap fixes (e2e)', () => {
  let app: NestExpressApplication;
  const envBefore: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
  });

  afterAll(async () => {
    // Before REDIS_URL is restored: the storage the health check created.
    redisThrottlerStorage()?.onApplicationShutdown();
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app?.close();
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
