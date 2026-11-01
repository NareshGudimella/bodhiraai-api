import { randomBytes } from 'node:crypto';
import { Controller, Get, Inject, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/auth.decorators';
import { iso8601 } from '../common/http/laravel';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { cache } from '../db/schema';
import { redisThrottlerStorage } from '../common/http/redis-throttler-storage';

@Controller()
export class HealthController {
  private readonly logger = new Logger('Health');

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * security: not in legacy. The deep check writes to the database, so it is
   * for the Worker, the web server and monitoring that hold PROXY_SECRET. With
   * no PROXY_SECRET configured it is open outside production (local runs).
   */
  private deepAllowed(req: Request) {
    if ((req as Request & { proxyAuthenticated?: boolean }).proxyAuthenticated)
      return true;
    return !process.env.PROXY_SECRET && process.env.NODE_ENV !== 'production';
  }

  /** Public liveness: `{ status }` only, from a read-only `select 1`. */
  private async liveness(res: Response) {
    try {
      await this.db.execute(sql`select 1`);
      res.status(200).json({ status: 'ok' });
    } catch (e) {
      this.logger.error(`Liveness check failed: ${(e as Error).message}`);
      res.status(503).json({ status: 'degraded' });
    }
  }

  /** GET /api/v1/ping — same payload as the legacy route. */
  @Public()
  @Get('ping')
  ping() {
    return {
      success: true,
      data: { service: 'bodhira-api', time: new Date().toISOString() },
    };
  }

  /**
   * GET /health (outside /api/v1, like legacy's web route): HealthController::check.
   * The same probes: `SELECT 1`, and a put/get/forget round trip on the
   * database `cache` table (legacy's cache store). `version` is Node's, where
   * legacy reports Laravel's.
   */
  @Public()
  @Get('health')
  async check(@Req() req: Request, @Res() res: Response) {
    if (!this.deepAllowed(req)) return this.liveness(res);
    const checks: Record<string, Record<string, unknown>> = {};
    let allOk = true;

    try {
      const start = performance.now();
      await this.db.execute(sql`select 1`);
      checks.db = {
        status: 'ok',
        latency_ms: Math.round((performance.now() - start) * 10) / 10,
      };
    } catch (e) {
      this.logger.error(`DB check failed: ${(e as Error).message}`);
      checks.db = { status: 'down' };
      allOk = false;
    }

    try {
      // Cache::put($key, '1', 5) / get / forget on the database store.
      const key = `bodhira-cache-health:${randomBytes(4).toString('hex')}`;
      await this.db.insert(cache).values({
        key,
        value: 's:1:"1";',
        expiration: BigInt(Math.floor(Date.now() / 1000) + 5),
      });
      const row = await this.db.query.cache.findFirst({
        where: eq(cache.key, key),
      });
      await this.db.delete(cache).where(eq(cache.key, key));
      const ok = row?.value === 's:1:"1";';
      checks.cache = {
        status: ok ? 'ok' : 'degraded',
        driver: process.env.CACHE_STORE ?? 'database',
      };
      if (!ok) allOk = false;
    } catch (e) {
      this.logger.error(`Cache check failed: ${(e as Error).message}`);
      checks.cache = { status: 'down' };
      allOk = false;
    }

    // Added (not in legacy): the shared rate-limit store, when configured.
    // Requests still succeed without it; each instance counts in its own
    // memory, so limits multiply with the instance count.
    const redis = redisThrottlerStorage();
    if (redis) {
      try {
        checks.redis = { status: 'ok', latency_ms: await redis.ping() };
      } catch (e) {
        this.logger.error(`Redis check failed: ${(e as Error).message}`);
        checks.redis = { status: 'down' };
        allOk = false;
      }
    }

    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      app: process.env.APP_NAME ?? 'Bodhira',
      environment: process.env.APP_ENV ?? 'production',
      version: process.version,
      checks,
      time: iso8601(new Date()),
    });
  }
}
