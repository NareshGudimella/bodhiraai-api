import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB, type Db } from '../db/db';
import { lessons, video_sessions } from '../db/schema';
import { JobsService, logSafe } from '../jobs/jobs.service';
import { encryptSecret } from '../mail/mail-crypto';
import { RETENTION_DAYS } from './video-session';
import { StorageService } from '../storage/storage.service';
import {
  assertDiskSpace,
  transcodeToHls,
  UnreadableVideo,
} from './hls-transcode';

/**
 * not in legacy: lesson-video jobs (docs/video-hls-contract.md).
 *
 *  - `video-transcode`: the upload was stored in the private bucket
 *    (`video-imports/…`) and the lesson marked `video_status = processing`. The
 *    job (worker host, needs `ffmpeg`) transcodes it to AES-128 encrypted HLS,
 *    uploads it to `hls/<lesson>/<version>/`, stores the prefix and the
 *    encrypted key on the lesson, clears the status and deletes the original
 *    and any older HLS prefix. On the final failure: `video_status = failed`,
 *    original deleted. Lessons never fall back to the raw file.
 *  - `video-delete`: deletes one HLS prefix (retried; inline without REDIS_URL).
 *
 * FFmpeg runs on the worker only: in production the web API queues the
 * transcode and never runs it itself, even when Redis is down. A lesson whose
 * job could not be queued stays `processing` (the original kept), and the
 * worker's sweep queues it at start and every 5 minutes.
 */
@Injectable()
export class VideoJobs
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('VideoJobs');
  private sweepTimer: NodeJS.Timeout | null = null;
  private cleanTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
  ) {
    jobs.handle('video-delete', (d: { prefix: string }) =>
      this.storage.deletePrivatePrefix(d.prefix),
    );
    jobs.handle(
      'video-transcode',
      (d: { lesson: string; key: string }, { final }) =>
        this.transcode(BigInt(d.lesson), d.key, final),
    );
  }

  /** Deletes HLS prefixes (best-effort when inline). */
  async deleteHls(...prefixes: (string | null | undefined)[]) {
    for (const prefix of prefixes.filter((p): p is string => !!p)) {
      const hash = createHash('sha256')
        .update(prefix)
        .digest('hex')
        .slice(0, 16);
      await this.jobs
        .run(
          'video-delete',
          { prefix },
          {
            jobId: `video-delete-${hash}`,
            inline: 'await',
          },
        )
        .catch((e: unknown) =>
          this.logger.warn(`Could not delete HLS video: ${logSafe(e)}`),
        );
    }
  }

  /**
   * Queues the transcode of a lesson's upload (`video_upload_key`). Outside
   * production without Redis it runs inline in the background (development,
   * tests); in production the web API never transcodes (no FFmpeg there).
   */
  async startTranscode(lessonId: bigint, key: string) {
    const data = { lesson: String(lessonId), key };
    const jobId = transcodeJobId(lessonId, key);
    if (process.env.NODE_ENV === 'production') {
      if (!(await this.jobs.enqueue('video-transcode', data, jobId)))
        this.logger.warn(
          `lesson=${lessonId} video-transcode not queued; the worker's sweep will queue it`,
        );
      return;
    }
    await this.jobs.run('video-transcode', data, {
      jobId,
      inline: 'background',
    });
  }

  /** Worker only: queue every upload still waiting for its transcode (idempotent job ids). */
  async sweep(): Promise<number> {
    const waiting = await this.db.query.lessons.findMany({
      where: and(
        eq(lessons.video_status, 'processing'),
        isNotNull(lessons.video_upload_key),
      ),
      columns: { id: true, video_upload_key: true },
    });
    let queued = 0;
    for (const l of waiting) {
      const key = l.video_upload_key as string;
      const data = { lesson: String(l.id), key };
      if (
        await this.jobs.enqueue(
          'video-transcode',
          data,
          transcodeJobId(l.id, key),
        )
      )
        queued++;
    }
    return queued;
  }

  /**
   * not in legacy: sets each HLS lesson's `duration_sec` to the video's real length,
   * the sum of its playlist's segment durations (fixes lessons whose duration was
   * typed in before transcoding measured it). Only changes rows that differ.
   */
  async syncDurations(): Promise<number> {
    const rows = await this.db.query.lessons.findMany({
      where: isNotNull(lessons.video_hls_path),
      columns: { id: true, video_hls_path: true, duration_sec: true },
    });
    let fixed = 0;
    for (const l of rows) {
      const playlist = await this.storage.getPrivate(
        `${l.video_hls_path}360p.m3u8`,
      );
      const seconds = playlist ? hlsDuration(playlist.toString('utf8')) : 0;
      if (seconds > 0 && seconds !== l.duration_sec) {
        await this.db
          .update(lessons)
          .set({ duration_sec: seconds })
          .where(eq(lessons.id, l.id));
        fixed++;
      }
    }
    if (fixed)
      this.logger.log(`video durations corrected on ${fixed} lesson(s)`);
    return fixed;
  }

  onApplicationBootstrap() {
    if ((process.env.APP_TYPE ?? '').trim().toUpperCase() !== 'WORKER') return;
    const run = () =>
      this.sweep().catch((e: unknown) =>
        this.logger.warn(`video sweep failed: ${logSafe(e)}`),
      );
    void run();
    this.sweepTimer = setInterval(() => void run(), 5 * 60_000);
    // Once at start: lessons transcoded before durations were measured get their real length.
    void this.syncDurations().catch((e: unknown) =>
      this.logger.warn(`video duration sync failed: ${logSafe(e)}`),
    );
    this.sweepTimer.unref();
    // Daily; deleting is idempotent, so several workers can do it.
    const clean = () =>
      this.cleanupSessions().catch((e: unknown) =>
        this.logger.warn(`video session cleanup failed: ${logSafe(e)}`),
      );
    void clean();
    this.cleanTimer = setInterval(() => void clean(), 24 * 3600_000);
    this.cleanTimer.unref();
  }

  onApplicationShutdown() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.cleanTimer) clearInterval(this.cleanTimer);
  }

  /** Strict playback protection: delete audit rows older than 180 days. */
  async cleanupSessions(now = new Date()) {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
    const rows = await this.db
      .delete(video_sessions)
      .where(lt(video_sessions.created_at, cutoff))
      .returning({ id: video_sessions.id });
    return rows.length;
  }

  /** The `video-transcode` job (one attempt). */
  async transcode(lessonId: bigint, key: string, final: boolean) {
    const lesson = await this.db.query.lessons.findFirst({
      where: eq(lessons.id, lessonId),
      columns: {
        video_status: true,
        video_upload_key: true,
        video_hls_path: true,
      },
    });
    if (
      lesson?.video_upload_key !== key ||
      lesson.video_status !== 'processing'
    ) {
      // Replaced or deleted meanwhile (whoever did it deletes the lesson's video).
      await this.storage.deletePrivate(key);
      return;
    }
    const mine = and(
      eq(lessons.id, lessonId),
      eq(lessons.video_upload_key, key),
    );
    const prefix = `hls/${lessonId}/${randomBytes(8).toString('hex')}/`;
    try {
      const size = await this.storage.sizeOfPrivate(key);
      if (size === null) throw new Error('The uploaded original is missing');
      const out = await this.withOriginal(key, size, async (src) => {
        return transcodeToHls(src, (f) =>
          this.storage.putPrivateFile(
            `${prefix}${f.name}`,
            f.path,
            f.contentType,
          ),
        );
      });
      const [kept] = await this.db
        .update(lessons)
        .set({
          video_hls_path: prefix,
          video_hls_key: encryptSecret(out.key.toString('base64')),
          // not in legacy: progress (the 90% rule) uses the video's real length.
          ...(out.durationSec > 0 && { duration_sec: out.durationSec }),
          video_status: null,
          video_upload_key: null,
        })
        .where(mine)
        .returning({ id: lessons.id });
      if (!kept) {
        // Replaced or deleted while transcoding.
        await this.storage.deletePrivatePrefix(prefix);
      } else if (lesson.video_hls_path) {
        await this.storage.deletePrivatePrefix(lesson.video_hls_path);
      }
      await this.storage.deletePrivate(key);
    } catch (e) {
      await this.storage.deletePrivatePrefix(prefix);
      // A file ffprobe can't read fails at once; anything else on the last attempt.
      const unreadable = e instanceof UnreadableVideo;
      if (final || unreadable) await this.fail(lessonId, key);
      throw unreadable ? new UnrecoverableError(e.message) : e;
    }
  }

  /**
   * Runs `fn` with the original on disk: the local file itself, or an R2
   * object streamed to a temp file (removed afterwards) once there is room.
   */
  private async withOriginal<T>(
    key: string,
    size: number,
    fn: (path: string) => Promise<T>,
  ): Promise<T> {
    const local = await this.storage.localPrivatePath(key);
    const dir = await mkdtemp(join(tmpdir(), 'bodhira-src-'));
    try {
      await assertDiskSpace(dir, size, !local);
      if (local) return await fn(local);
      const path = join(dir, 'original');
      await this.storage.downloadPrivate(key, path);
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Gives up on an upload: `video_status = failed`, the original deleted. */
  async fail(lessonId: bigint, key: string) {
    await this.db
      .update(lessons)
      .set({ video_status: 'failed', video_upload_key: null })
      .where(and(eq(lessons.id, lessonId), eq(lessons.video_upload_key, key)));
    await this.storage.deletePrivate(key);
    this.logger.warn(
      `lesson=${lessonId} video transcode failed; the editor can upload again`,
    );
  }
}

/** One job per upload: queueing it again (sweep, retries) is a no-op while it exists. */
export function transcodeJobId(lessonId: bigint, key: string) {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `video-transcode-${lessonId}-${hash}`;
}

/** A VOD playlist's length in whole seconds: the sum of its `#EXTINF` durations. */
export function hlsDuration(playlist: string): number {
  let total = 0;
  for (const m of playlist.matchAll(/^#EXTINF:([\d.]+)/gm))
    total += Number(m[1]);
  return Math.round(total);
}
