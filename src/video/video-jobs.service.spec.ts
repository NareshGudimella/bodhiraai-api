import { UnrecoverableError } from 'bullmq';
import type { Db } from '../db/db';
import type { JobsService } from '../jobs/jobs.service';
import type { StorageService } from '../storage/storage.service';
import type { VdoCipherClient } from './vdocipher.client';
import { VideoJobs } from './video-jobs.service';

const KEY = 'video-imports/lessons/1/clip-abcdefgh.webm';
const VIDEO = 'a'.repeat(32);

/** Fakes: the lesson row, VdoCipher (import id, status), storage; records writes. */
function setup(lesson: Record<string, unknown> | undefined, status = 'ready') {
  const sets: Record<string, unknown>[] = [];
  const update = () => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      if (lesson) Object.assign(lesson, v);
      const done = Promise.resolve(undefined);
      return {
        where: () =>
          Object.assign(done, {
            returning: () => Promise.resolve(lesson ? [{ id: 1n }] : []),
          }),
      };
    },
  });
  const db = {
    query: {
      lessons: { findFirst: () => Promise.resolve(lesson && { ...lesson }) },
    },
    update,
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve(lesson ? [{ video_id: lesson.video_id }] : []),
      }),
    }),
  } as unknown as Db;
  const vdo = {
    configured: () => true,
    importUrl: jest.fn().mockResolvedValue(VIDEO),
    status: jest.fn().mockResolvedValue(status),
    delete: jest.fn(),
    deleteBestEffort: jest.fn(),
  };
  const storage = {
    presignPrivate: jest.fn().mockResolvedValue('https://r2.example/presigned'),
    deletePrivate: jest.fn(),
  };
  const jobs = {
    handle: jest.fn(),
    ready: true,
    run: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(true),
  };
  const svc = new VideoJobs(
    db,
    storage as unknown as StorageService,
    vdo as unknown as VdoCipherClient,
    jobs as unknown as JobsService,
  );
  jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
  return { svc, sets, vdo, storage, jobs };
}

const processing = () => ({
  title: 'Cells',
  video_id: null as string | null,
  video_status: 'processing' as string | null,
  video_upload_key: KEY as string | null,
});

describe('VideoJobs (video-import job)', () => {
  it('imports from a presigned link, then finishes once VdoCipher reports ready', async () => {
    const lesson = processing();
    const { svc, vdo, storage, sets } = setup(lesson);
    await svc.importVideo(1n, KEY, false);
    expect(storage.presignPrivate).toHaveBeenCalledWith(KEY, 12 * 3600);
    expect(vdo.importUrl).toHaveBeenCalledWith(
      'https://r2.example/presigned',
      'Cells',
    );
    expect(sets).toEqual([
      { video_id: VIDEO },
      { video_status: null, video_upload_key: null },
    ]);
    expect(storage.deletePrivate).toHaveBeenCalledWith(KEY);
  });

  it('retries while VdoCipher is still processing, without importing twice', async () => {
    const lesson = processing();
    const { svc, vdo, storage } = setup(lesson, 'Queued');
    await expect(svc.importVideo(1n, KEY, false)).rejects.toThrow(
      'not ready yet (queued)',
    );
    await expect(svc.importVideo(1n, KEY, false)).rejects.toThrow('not ready');
    expect(vdo.importUrl).toHaveBeenCalledTimes(1);
    expect(lesson.video_status).toBe('processing');
    expect(storage.deletePrivate).not.toHaveBeenCalled();
  });

  it('marks the lesson failed on the last attempt, deleting the import and the file', async () => {
    const lesson = processing();
    const { svc, jobs, storage } = setup(lesson, 'Queued');
    await expect(svc.importVideo(1n, KEY, true)).rejects.toThrow('not ready');
    expect(lesson).toEqual(
      expect.objectContaining({
        video_status: 'failed',
        video_id: null,
        video_upload_key: null,
      }),
    );
    expect(jobs.run).toHaveBeenCalledWith(
      'video-delete',
      { video: VIDEO },
      expect.objectContaining({ jobId: `video-delete-${VIDEO}` }),
    );
    expect(storage.deletePrivate).toHaveBeenCalledWith(KEY);
  });

  it('gives up at once when VdoCipher reports an error', async () => {
    const lesson = processing();
    const { svc } = setup(lesson, 'Error');
    await expect(svc.importVideo(1n, KEY, false)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(lesson.video_status).toBe('failed');
  });

  it('only drops the file when the lesson was replaced or deleted meanwhile', async () => {
    for (const lesson of [
      undefined,
      { ...processing(), video_upload_key: 'other' },
    ]) {
      const { svc, vdo, storage, sets } = setup(lesson);
      await svc.importVideo(1n, KEY, false);
      expect(vdo.importUrl).not.toHaveBeenCalled();
      expect(sets).toEqual([]);
      expect(storage.deletePrivate).toHaveBeenCalledWith(KEY);
    }
  });

  it('marks the lesson failed when the job cannot be queued', async () => {
    const lesson = processing();
    const { svc, jobs } = setup(lesson);
    jobs.enqueue.mockResolvedValue(false);
    await svc.startImport(1n, KEY);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'video-import',
      { lesson: '1', key: KEY },
      expect.stringMatching(/^video-import-1-[a-f0-9]{16}$/),
    );
    expect(lesson.video_status).toBe('failed');
  });
});
