import {
  OnApplicationBootstrap,
  Global,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';

/**
 * not in legacy: background jobs (legacy dispatches none; it did this work
 * inside the request). With REDIS_URL the API only enqueues to BullMQ and the
 * worker process (`src/worker.ts`) runs the handlers; without it (local
 * development, tests, a single box) every job runs inline in the calling
 * process, as before.
 */
export type JobName =
  | 'password-reset'
  | 'invoice'
  | 'notifications'
  | 'video-delete'
  | 'video-transcode';

/** `final`: the last attempt (always true inline), where handlers give up gracefully. */
export interface JobContext {
  final: boolean;
}

type Handler = (data: any, ctx: JobContext) => Promise<void>;

/** Attempts and the first retry delay (doubling each time) per job. */
export const JOB_POLICY: Record<JobName, { attempts: number; delay: number }> =
  {
    'password-reset': { attempts: 5, delay: 10_000 },
    invoice: { attempts: 6, delay: 30_000 },
    notifications: { attempts: 5, delay: 5_000 },
    'video-delete': { attempts: 8, delay: 60_000 },
    // CPU-heavy (ffmpeg); a few retries for a busy host or a storage hiccup.
    'video-transcode': { attempts: 3, delay: 60_000 },
  };

export const QUEUE_NAME = 'jobs';

/** Error text for logs: one line, bounded, email addresses masked. */
/** host:port/db of a Redis URL, without the password (for logs). */
export function redisTarget(url: string | null): string {
  if (!url) return 'none';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || 6379}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`;
  } catch {
    return 'an invalid REDIS_URL';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function logSafe(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e))
    .replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

@Injectable()
export class JobsService
  implements BeforeApplicationShutdown, OnApplicationBootstrap
{
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<JobName, Handler>();
  private readonly url = process.env.REDIS_URL || null;
  private readonly prefix = process.env.BULLMQ_PREFIX || 'bodhira';
  /**
   * The producer's connection, opened at start. Jobs are added only while it
   * is ready (BullMQ would otherwise wait for Redis indefinitely); a command
   * cut off by a disconnect fails after one retry.
   */
  private readonly redis = this.url
    ? new Redis(this.url, { maxRetriesPerRequest: 1 })
    : null;
  private queueInstance: Queue | null = null;
  private worker: Worker | null = null;
  private lastWarning = 0;
  /** The last connection error, for the startup line (ioredis' own retry error hides it). */
  private lastError: unknown = null;

  constructor() {
    // not in legacy: a line when the connection comes back or drops after start.
    this.redis?.on('ready', () => {
      if (this.lastWarning)
        this.logger.log(`Redis reconnected (${redisTarget(this.url)})`);
      this.lastWarning = 0;
    });
    this.redis?.on('error', (e: Error) => {
      this.lastError = e;
      // At most one line a minute while Redis is down.
      if (Date.now() - this.lastWarning < 60_000) return;
      this.lastWarning = Date.now();
      this.logger.warn(`Redis unavailable for jobs: ${logSafe(e)}`);
    });
  }

  /**
   * not in legacy: at start (web and worker), log whether Redis answers, so a
   * wrong REDIS_URL or password shows in the first lines of the log. Never fails
   * the start: without Redis, jobs run inline and rate limits count in memory.
   */
  async onApplicationBootstrap() {
    if (!this.redis) {
      this.logger.log(
        'Redis: not configured (REDIS_URL unset): jobs run inline, rate limits in memory',
      );
      return;
    }
    const target = redisTarget(this.url);
    const started = Date.now();
    try {
      const info = await withTimeout(this.redis.info(), 5000);
      const field = (k: string) =>
        new RegExp(`^${k}:(.*)$`, 'm').exec(info)?.[1]?.trim() ?? '?';
      const policy = field('maxmemory_policy');
      this.logger.log(
        `Redis: connected ${target} in ${Date.now() - started} ms (redis ${field('redis_version')}, maxmemory-policy ${policy}, prefix ${this.prefix})`,
      );
      if (policy !== 'noeviction' && policy !== '?')
        this.logger.warn(
          `Redis: maxmemory-policy is ${policy}; BullMQ needs noeviction or queued jobs can be lost`,
        );
    } catch (e) {
      this.lastWarning = Date.now();
      this.logger.error(
        `Redis: unreachable at ${target} (${logSafe(this.lastError ?? e)}): jobs run inline and rate limits count per instance until it is back`,
      );
    }
  }

  /** True when jobs go to Redis (REDIS_URL); false: they run inline. */
  get queued(): boolean {
    return this.url !== null;
  }

  /** Queued and connected right now (a job added now is accepted). */
  get ready(): boolean {
    return this.redis?.status === 'ready';
  }

  private get queue(): Queue | null {
    if (!this.redis) return null;
    this.queueInstance ??= new Queue(QUEUE_NAME, {
      prefix: this.prefix,
      connection: this.redis,
      defaultJobOptions: {
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 14 * 24 * 3600, count: 5000 },
      },
    });
    return this.queueInstance;
  }

  /** Registers the handler for `name` (each owning service does this in its constructor). */
  handle(name: JobName, fn: Handler) {
    this.handlers.set(name, fn);
  }

  /**
   * Adds a job; false when there is no queue or Redis refused it (logged).
   * `jobId` makes it idempotent: a job with the same id is not added twice.
   * Ids are logged, so they carry no personal data.
   */
  async enqueue(name: JobName, data: object, jobId: string): Promise<boolean> {
    const queue = this.queue;
    if (!queue) return false;
    const { attempts, delay } = JOB_POLICY[name];
    try {
      if (this.redis?.status !== 'ready')
        throw new Error(`Redis connection ${this.redis?.status}`);
      await queue.add(name, data, {
        jobId,
        attempts,
        backoff: { type: 'exponential', delay },
      });
      this.logger.log(`job=${name} id=${jobId} status=queued`);
      return true;
    } catch (e) {
      this.logger.error(
        `job=${name} id=${jobId} status=enqueue_failed error=${logSafe(e)}`,
      );
      return false;
    }
  }

  /**
   * Enqueues the job, or runs the handler here when there is no queue (or
   * Redis refused it): awaited (`await`, errors propagate) or in the
   * background (`background`, errors logged), as the code it replaced did.
   */
  async run(
    name: JobName,
    data: object,
    opts: { jobId: string; inline: 'await' | 'background' },
  ): Promise<void> {
    if (await this.enqueue(name, data, opts.jobId)) return;
    const work = this.handler(name)(data, { final: true });
    if (opts.inline === 'await') return work;
    work.catch((e: unknown) =>
      this.logger.error(
        `job=${name} id=${opts.jobId} status=failed inline=1 error=${logSafe(e)}`,
      ),
    );
  }

  private handler(name: string): Handler {
    const fn = this.handlers.get(name as JobName);
    if (!fn) throw new UnrecoverableError(`No handler for job ${name}`);
    return fn;
  }

  /** The BullMQ processor: runs one attempt of a job. Exported for the unit tests. */
  async process(job: Job): Promise<void> {
    const attempt = job.attemptsMade + 1;
    const attempts = job.opts.attempts ?? 1;
    const tag = `job=${job.name} id=${job.id} attempt=${attempt}/${attempts}`;
    const start = performance.now();
    try {
      await this.handler(job.name)(job.data, { final: attempt >= attempts });
    } catch (e) {
      this.logger[attempt >= attempts ? 'error' : 'warn'](
        `${tag} status=failed ms=${Math.round(performance.now() - start)} error=${logSafe(e)}`,
      );
      throw e;
    }
    this.logger.log(
      `${tag} status=done ms=${Math.round(performance.now() - start)}`,
    );
  }

  /** The worker process only (`src/worker.ts`): consume the queue. */
  startWorker(concurrency = Number(process.env.WORKER_CONCURRENCY) || 5) {
    if (!this.url) throw new Error('The worker needs REDIS_URL');
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
      prefix: this.prefix,
      // Workers wait for Redis to come back rather than failing commands.
      connection: { url: this.url, maxRetriesPerRequest: null },
      concurrency,
    });
    this.worker.on('error', (e) =>
      this.logger.error(`worker error=${logSafe(e)}`),
    );
    this.logger.log(
      `worker started queue=${QUEUE_NAME} concurrency=${concurrency}`,
    );
    return this.worker;
  }

  /** Waiting/active/delayed/failed counts, for the deep /health. */
  async counts() {
    const queue = this.queue;
    if (!queue) return null;
    if (this.redis?.status !== 'ready')
      throw new Error(`Redis connection ${this.redis?.status}`);
    return queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  }

  /** Graceful stop: running jobs finish before the database pool closes (onApplicationShutdown). */
  async beforeApplicationShutdown() {
    // Graceful (running jobs finish) only while Redis works. Without it (down,
    // wrong password) no job can finish, and a graceful close would wait until
    // PM2 kills the process (kill_timeout); close at once instead.
    const force = this.redis?.status !== 'ready';
    if (force && this.worker)
      this.logger.warn(
        `Redis ${this.redis?.status}: stopping the worker without waiting`,
      );
    await this.worker?.close(force);
    if (force) this.redis?.disconnect();
    await this.queueInstance?.close();
    this.redis?.disconnect();
  }
}

@Global()
@Module({ providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
