import { RedisThrottlerStorage } from './redis-throttler-storage';

describe('RedisThrottlerStorage when Redis is down', () => {
  it('counts in memory instead of letting everything through', async () => {
    // Nothing listens on port 1.
    const storage = new RedisThrottlerStorage('redis://127.0.0.1:1');
    try {
      const hit = () => storage.increment('k', 60_000, 3, 0, 'default');
      const results = [await hit(), await hit(), await hit(), await hit()];
      expect(results.map((r) => r.totalHits)).toEqual([1, 2, 3, 4]);
      expect(results.map((r) => r.isBlocked)).toEqual([
        false,
        false,
        false,
        true,
      ]);
    } finally {
      storage.onApplicationShutdown();
    }
  });
});
