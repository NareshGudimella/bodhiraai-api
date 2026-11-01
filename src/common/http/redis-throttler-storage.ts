import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  ThrottlerStorageService,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import Redis from 'ioredis';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * Hits within the window, and a block once the limit is passed (the in-memory
 * storage's behaviour, which @RateLimit() relies on). Keys expire on their own.
 * Returns hits, ms left in the window, blocked (0/1), ms left in the block.
 */
const SCRIPT = `
local blocked = redis.call('PTTL', KEYS[2])
if blocked > 0 then
  return {tonumber(ARGV[2]) + 1, blocked, 1, blocked}
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local left = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) then
  if tonumber(ARGV[3]) <= 0 then return {hits, left, 1, left} end
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  redis.call('DEL', KEYS[1])
  return {hits, left, 1, tonumber(ARGV[3])}
end
return {hits, left, 0, 0}
`;

/**
 * Rate-limit counters shared by every API instance (REDIS_URL). Without it
 * each instance would count on its own and the limits would multiply with the
 * instance count. security: not in legacy: if Redis is unreachable, counting
 * falls back to this instance's memory (limits stay on, per instance) rather
 * than letting every request through.
 */
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  private readonly logger = new Logger('RateLimit');
  private readonly redis: Redis;
  private lastWarning = 0;
  private readonly memory = new ThrottlerStorageService();

  constructor(url: string) {
    this.redis = new Redis(url, {
      keyPrefix: 'bodhira:throttle:',
      // Fail fast while disconnected instead of queueing requests.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', (e: Error) => this.warn(e));
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${throttlerName}:${key}`;
    try {
      const [hits, left, blocked, blockLeft] = (await this.redis.eval(
        SCRIPT,
        2,
        `${base}:hits`,
        `${base}:block`,
        ttl,
        limit,
        blockDuration,
      )) as number[];
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(left / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(blockLeft / 1000),
      };
    } catch (e) {
      this.warn(e as Error);
      return this.memory.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }

  /** Round-trip time in ms; throws when Redis is unreachable (for /health). */
  async ping(): Promise<number> {
    const start = performance.now();
    await this.redis.ping();
    return Math.round((performance.now() - start) * 10) / 10;
  }

  onApplicationShutdown() {
    this.redis.disconnect();
    this.memory.onApplicationShutdown();
  }

  /** At most one log line a minute while Redis is down. */
  private warn(e: Error) {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(
      `Redis unavailable, rate limiting in memory on this instance: ${e.message}`,
    );
  }
}

let shared: RedisThrottlerStorage | null = null;

/** The process's Redis storage when REDIS_URL is set, else null (counters in memory). */
export function redisThrottlerStorage(): RedisThrottlerStorage | null {
  if (!process.env.REDIS_URL) return null;
  shared ??= new RedisThrottlerStorage(process.env.REDIS_URL);
  return shared;
}
