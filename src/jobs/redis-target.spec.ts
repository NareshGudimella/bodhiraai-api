import { redisTarget } from './jobs.service';

describe('redisTarget (startup log, not in legacy)', () => {
  it('shows host, port and db, never the password', () => {
    const t = redisTarget('redis://:s3cret-pw@10.0.1.25:6379/2');
    expect(t).toBe('redis://10.0.1.25:6379/2');
    expect(t).not.toContain('s3cret');
    expect(redisTarget('rediss://user:pw@cache.internal')).toBe(
      'rediss://cache.internal:6379',
    );
  });

  it('handles unset and malformed URLs', () => {
    expect(redisTarget(null)).toBe('none');
    expect(redisTarget('not a url')).toBe('an invalid REDIS_URL');
  });
});
