import { UnrecoverableError, type Job } from 'bullmq';
import { JOB_POLICY, JobsService, logSafe } from './jobs.service';

/** A JobsService with a fake queue (as with REDIS_URL), or none (inline). */
function service(queue?: { add: jest.Mock }) {
  const svc = new JobsService();
  if (queue)
    Object.defineProperties(svc, {
      queued: { get: () => true },
      queue: { get: () => queue },
      redis: { value: { status: 'ready' } },
    });
  return svc;
}

const job = (name: string, attemptsMade: number, attempts = 3) =>
  ({
    name,
    id: 'x-1',
    data: { a: 1 },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job;

describe('JobsService', () => {
  const env = process.env.REDIS_URL;
  beforeAll(() => delete process.env.REDIS_URL);
  afterAll(() => {
    if (env !== undefined) process.env.REDIS_URL = env;
  });

  describe('without REDIS_URL (inline)', () => {
    it('awaits the handler, which sees its only attempt as final, and passes errors on', async () => {
      const svc = service();
      expect(svc.queued).toBe(false);
      const seen: unknown[] = [];
      svc.handle('notifications', async (d, ctx) => {
        await Promise.resolve();
        seen.push(d, ctx);
      });
      await svc.run(
        'notifications',
        { n: 1 },
        { jobId: 'n-1', inline: 'await' },
      );
      expect(seen).toEqual([{ n: 1 }, { final: true }]);

      svc.handle('invoice', () => Promise.reject(new Error('boom')));
      await expect(
        svc.run('invoice', {}, { jobId: 'i-1', inline: 'await' }),
      ).rejects.toThrow('boom');
      expect(await svc.enqueue('invoice', {}, 'i-1')).toBe(false);
    });

    it('runs background jobs without waiting, logging failures', async () => {
      const svc = service();
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      let finished = false;
      svc.handle('password-reset', async () => {
        await done;
        finished = true;
        throw new Error('smtp down for a@b.test');
      });
      const errors = jest
        .spyOn(svc['logger'], 'error')
        .mockImplementation(() => undefined);
      await svc.run(
        'password-reset',
        {},
        { jobId: 'p-1', inline: 'background' },
      );
      expect(finished).toBe(false);
      release();
      await new Promise((r) => setImmediate(r));
      expect(finished).toBe(true);
      expect(errors).toHaveBeenCalledWith(
        'job=password-reset id=p-1 status=failed inline=1 error=smtp down for [email]',
      );
    });
  });

  describe('with a queue', () => {
    it('only enqueues, with the job id, retries and backoff', async () => {
      const add = jest.fn().mockResolvedValue({});
      const svc = service({ add });
      jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
      const handler = jest.fn();
      svc.handle('invoice', handler);
      await svc.run(
        'invoice',
        { invoice: '7' },
        { jobId: 'invoice-7', inline: 'await' },
      );
      expect(handler).not.toHaveBeenCalled();
      expect(add).toHaveBeenCalledWith(
        'invoice',
        { invoice: '7' },
        {
          jobId: 'invoice-7',
          attempts: JOB_POLICY.invoice.attempts,
          backoff: { type: 'exponential', delay: JOB_POLICY.invoice.delay },
        },
      );
    });

    it('runs the job here when Redis refuses it', async () => {
      const svc = service({
        add: jest.fn().mockRejectedValue(new Error('down')),
      });
      jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
      const handler = jest.fn().mockResolvedValue(undefined);
      svc.handle('notifications', handler);
      await svc.run(
        'notifications',
        { n: 2 },
        { jobId: 'n-2', inline: 'await' },
      );
      expect(handler).toHaveBeenCalledWith({ n: 2 }, { final: true });
    });

    it('does not add while the connection is not ready', async () => {
      const add = jest.fn();
      const svc = service({ add });
      Object.defineProperty(svc, 'redis', {
        value: { status: 'reconnecting' },
      });
      jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
      expect(await svc.enqueue('video-transcode', {}, 'v-1')).toBe(false);
      expect(add).not.toHaveBeenCalled();
    });
  });

  describe('process() (the worker)', () => {
    it('tells the handler whether this is the last attempt', async () => {
      const svc = service();
      jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
      const handler = jest.fn().mockResolvedValue(undefined);
      svc.handle('video-delete', handler);
      await svc.process(job('video-delete', 0));
      await svc.process(job('video-delete', 2));
      expect(handler.mock.calls.map((c: unknown[]) => c[1])).toEqual([
        { final: false },
        { final: true },
      ]);
    });

    it('rethrows failures (BullMQ retries) and refuses unknown jobs for good', async () => {
      const svc = service();
      const warn = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined);
      svc.handle('invoice', () => Promise.reject(new Error('render')));
      await expect(svc.process(job('invoice', 0))).rejects.toThrow('render');
      expect(warn.mock.calls[0][0]).toMatch(
        /^job=invoice id=x-1 attempt=1\/3 status=failed ms=\d+ error=render$/,
      );
      await expect(svc.process(job('nope', 0))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });
  });

  it('masks email addresses and bounds log text', () => {
    expect(logSafe(new Error('550 <someone@example.com> rejected\n x'))).toBe(
      '550 <[email]> rejected x',
    );
    expect(logSafe('x'.repeat(400))).toHaveLength(301);
  });
});
