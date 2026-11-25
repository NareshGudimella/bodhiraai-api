import {
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
  | 'video-import';

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
    // Also polls VdoCipher until the video is ready: ~8.5 hours in all.
    'video-import': { attempts: 10, delay: 30_000 },
  };

export const QUEUE_NAME = 'jobs';

/** Error text for logs: one line, bounded, email addresses masked. */
export function logSafe(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e))
    .replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

@Injectable()
export class JobsService implements BeforeApplicationShutdown {
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

  constructor() {
    this.redis?.on('error', (e: Error) => {
      // At most one line a minute while Redis is down.
      if (Date.now() - this.lastWarning < 60_000) return;
      this.lastWarning = Date.now();
      this.logger.warn(`Redis unavailable for jobs: ${logSafe(e)}`);
    });
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
    await this.worker?.close();
    await this.queueInstance?.close();
    this.redis?.disconnect();
  }
}

@Global()
@Module({ providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
