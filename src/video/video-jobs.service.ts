import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DB, type Db } from '../db/db';
import { lessons } from '../db/schema';
import { JobsService, logSafe } from '../jobs/jobs.service';
import { StorageService } from '../storage/storage.service';
import { isVideoId, VdoCipherClient } from './vdocipher.client';

/** How long VdoCipher may take to fetch the temporary upload. */
const IMPORT_LINK_TTL = 12 * 3600;

/**
 * not in legacy: lesson-video jobs.
 *
 *  - `video-delete`: one retried job per VdoCipher video (without REDIS_URL:
 *    deleted right away, best-effort, as before).
 *  - `video-import` (only with REDIS_URL and VdoCipher): the upload was stored
 *    in the private bucket and the lesson marked `video_status = processing`;
 *    the job imports it into VdoCipher (importUrl with a presigned link),
 *    stores `video_id`, then polls until VdoCipher reports the video ready,
 *    clears the status and deletes the temporary object. If it gives up, the
 *    lesson gets `video_status = failed` and no video, for the editor to
 *    upload again. Lessons never fall back to the raw file (DRM).
 */
@Injectable()
export class VideoJobs {
  private readonly logger = new Logger('VideoJobs');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly vdo: VdoCipherClient,
    private readonly jobs: JobsService,
  ) {
    jobs.handle('video-delete', (d: { video: string }) =>
      this.vdo.delete(d.video),
    );
    jobs.handle(
      'video-import',
      (d: { lesson: string; key: string }, { final }) =>
        this.importVideo(BigInt(d.lesson), d.key, final),
    );
  }

  /**
   * True when uploads go through `video-import`: REDIS_URL, connected, and a
   * VdoCipher secret. While Redis is down uploads go to VdoCipher directly.
   */
  async queued(): Promise<boolean> {
    return this.jobs.ready && (await this.vdo.configured());
  }

  /** Deletes VdoCipher videos (best-effort when inline, like deleteBestEffort). */
  async deleteVideos(...ids: (string | null | undefined)[]) {
    for (const id of ids.filter(isVideoId)) {
      await this.jobs
        .run(
          'video-delete',
          { video: id },
          {
            jobId: `video-delete-${id.toLowerCase()}`,
            inline: 'await',
          },
        )
        .catch((e: unknown) =>
          this.logger.warn(`Could not delete VdoCipher video: ${logSafe(e)}`),
        );
    }
  }

  /** Queues the import of a lesson's temporary upload (`video_upload_key`). */
  async startImport(lessonId: bigint, key: string) {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const queued = await this.jobs.enqueue(
      'video-import',
      { lesson: String(lessonId), key },
      `video-import-${lessonId}-${hash}`,
    );
    // Redis refused it: nothing would ever import the file.
    if (!queued) await this.fail(lessonId, key);
  }

  /** The `video-import` job (one attempt). */
  async importVideo(lessonId: bigint, key: string, final: boolean) {
    const lesson = await this.db.query.lessons.findFirst({
      where: eq(lessons.id, lessonId),
      columns: {
        title: true,
        video_id: true,
        video_status: true,
        video_upload_key: true,
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
    try {
      let videoId = lesson.video_id;
      if (!videoId) {
        videoId = await this.vdo.importUrl(
          await this.storage.presignPrivate(key, IMPORT_LINK_TTL),
          lesson.title || `Lesson ${lessonId}`,
        );
        const [kept] = await this.db
          .update(lessons)
          .set({ video_id: videoId })
          .where(mine)
          .returning({ id: lessons.id });
        if (!kept) {
          await this.vdo.deleteBestEffort(videoId);
          await this.storage.deletePrivate(key);
          return;
        }
      }
      const status = (await this.vdo.status(videoId)).toLowerCase();
      if (/error|fail/.test(status))
        throw new UnrecoverableError(
          `VdoCipher could not process the video (${status})`,
        );
      // Retried with backoff until ready (attempts in JOB_POLICY).
      if (status !== 'ready')
        throw new Error(
          `VdoCipher video not ready yet (${status || 'unknown'})`,
        );
      await this.db
        .update(lessons)
        .set({ video_status: null, video_upload_key: null })
        .where(mine);
      await this.storage.deletePrivate(key);
    } catch (e) {
      if (final || e instanceof UnrecoverableError)
        await this.fail(lessonId, key);
      throw e;
    }
  }

  /** Gives up on an upload: no video, `video_status = failed`, temporary object and any import deleted. */
  async fail(lessonId: bigint, key: string) {
    const [row] = await this.db
      .select({ video_id: lessons.video_id })
      .from(lessons)
      .where(and(eq(lessons.id, lessonId), eq(lessons.video_upload_key, key)));
    if (row) {
      await this.db
        .update(lessons)
        .set({ video_status: 'failed', video_id: null, video_upload_key: null })
        .where(
          and(eq(lessons.id, lessonId), eq(lessons.video_upload_key, key)),
        );
      await this.deleteVideos(row.video_id);
    }
    await this.storage.deletePrivate(key);
    this.logger.warn(
      `lesson=${lessonId} video import failed; the editor can upload again`,
    );
  }
}
