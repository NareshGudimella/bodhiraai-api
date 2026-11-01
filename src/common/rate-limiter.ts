import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';

/**
 * security: not in legacy. A second, explicit limit on top of a route's
 * `@RateLimit()` (which counts one key per route), e.g. per phone number as
 * well as per IP. Uses the same storage (Redis when REDIS_URL is set).
 */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
  ) {}

  /** Counts one hit for `name:key`; throws the usual 429 once `limit` hits per `ttlMs` is passed. */
  async hit(name: string, key: string, limit: number, ttlMs: number) {
    const r = await this.storage.increment(
      `${name}:${key}`,
      ttlMs,
      limit,
      0,
      `extra-${name}`,
    );
    if (r.isBlocked || r.totalHits > limit) throw new ThrottlerException();
  }
}

@Global()
@Module({ providers: [RateLimiter], exports: [RateLimiter] })
export class RateLimiterModule {}
