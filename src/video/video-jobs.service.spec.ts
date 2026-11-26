import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnrecoverableError } from 'bullmq';
import type { Db } from '../db/db';
import type { JobsService } from '../jobs/jobs.service';
import { decryptSecret } from '../mail/mail-crypto';
import { StorageService } from '../storage/storage.service';
import { apiOrigin, signUpload, verifyUpload } from './direct-upload';
import { assertDiskSpace, transcodeToHls } from './hls-transcode';
import { VideoJobs } from './video-jobs.service';

const KEY = 'video-imports/lessons/1/clip-abcdefgh.mp4';

/** Fakes the lesson row and records writes; real local storage and real ffmpeg. */
function setup(lesson: Record<string, unknown> | undefined) {
  const sets: Record<string, unknown>[] = [];
  const db = {
    query: {
      lessons: { findFirst: () => Promise.resolve(lesson && { ...lesson }) },
    },
    update: () => ({
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
    }),
  } as unknown as Db;
  const jobs = { handle: jest.fn(), run: jest.fn() };
  const storage = new StorageService({} as never);
  const svc = new VideoJobs(db, storage, jobs as unknown as JobsService);
  jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
  return { svc, sets, storage };
}

const processing = () => ({
  video_status: 'processing' as string | null,
  video_upload_key: KEY as string | null,
  video_hls_path: null as string | null,
});

describe('VideoJobs (video-transcode job, real ffmpeg)', () => {
  let dir: string;
  const env: Record<string, string | undefined> = {};
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hls-spec-'));
    for (const k of ['STORAGE_DRIVER', 'LOCAL_PRIVATE_DIR'])
      env[k] = process.env[k];
    process.env.STORAGE_DRIVER = 'local';
    process.env.LOCAL_PRIVATE_DIR = join(dir, 'private');
    // 3 s test clip, 1280x720 with audio
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=25:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'clip.mp4'),
    ]);
  }, 60_000);
  afterAll(async () => {
    for (const [k, v] of Object.entries(env))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  });

  const putOriginal = async (storage: StorageService) =>
    storage.putPrivate(KEY, await readFile(join(dir, 'clip.mp4')), 'video/mp4');

  it('makes encrypted HLS, stores the encrypted key and deletes the original', async () => {
    const lesson = processing();
    const { svc, sets, storage } = setup(lesson);
    await putOriginal(storage);
    await svc.transcode(1n, KEY, true);

    const set = sets[0];
    const prefix = set.video_hls_path as string;
    expect(prefix).toMatch(/^hls\/1\/[0-9a-f]{16}\/$/);
    expect(set).toMatchObject({ video_status: null, video_upload_key: null });
    const key = Buffer.from(
      decryptSecret(set.video_hls_key as string),
      'base64',
    );
    expect(key).toHaveLength(16);

    const root = join(StorageService.privateDir(), prefix);
    const names = await readdir(root);
    expect(names).toEqual(
      expect.arrayContaining(['master.m3u8', '360p.m3u8', '720p.m3u8']),
    );
    const master = await readFile(join(root, 'master.m3u8'), 'utf8');
    expect(master).toContain('RESOLUTION=1280x720');
    expect(master).toContain('RESOLUTION=640x360');
    for (const r of ['360p', '720p']) {
      const pl = await readFile(join(root, `${r}.m3u8`), 'utf8');
      expect(pl).toMatch(
        /#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x[0-9a-f]{32}/,
      );
      expect(pl).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
      expect(pl).toContain('#EXT-X-ENDLIST');
    }
    // Segments are ciphertext: not playable without the key.
    const seg = names.find((n) => n.startsWith('720p_') && n.endsWith('.ts'))!;
    const segPath = join(root, seg);
    expect((await stat(segPath)).size % 16).toBe(0); // AES-CBC blocks
    const probe = (file: string) =>
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type',
          '-of',
          'csv=p=0',
          file,
        ],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).toString();
    expect(() => probe(segPath)).toThrow();
    expect((await readFile(segPath))[0]).not.toBe(0x47); // MPEG-TS sync byte

    // The original is gone.
    expect(await storage.getPrivate(KEY)).toBeNull();
  }, 120_000);

  it('transcodeToHls streams a file path to per-file uploads from disk', async () => {
    const seen: Record<string, number> = {};
    const { key } = await transcodeToHls(join(dir, 'clip.mp4'), async (f) => {
      seen[f.name] = (await stat(f.path)).size; // exists while uploading
    });
    expect(key).toHaveLength(16);
    expect(Object.keys(seen)).toEqual(
      expect.arrayContaining(['master.m3u8', '360p.m3u8', '720p_00000.ts']),
    );
  }, 120_000);

  it('refuses a source that does not fit on disk, with a clear message', async () => {
    await expect(assertDiskSpace(dir, 1e15, true)).rejects.toThrow(
      /Not enough free disk space/,
    );
    await expect(assertDiskSpace(dir, 1000, true)).resolves.toBeUndefined();
  });

  it('gives up on garbage: failed status, original deleted, nothing left under hls/', async () => {
    const lesson = processing();
    const { svc, sets, storage } = setup(lesson);
    await storage.putPrivate(KEY, Buffer.from('not a video'), 'video/mp4');
    await expect(svc.transcode(1n, KEY, true)).rejects.toThrow();
    expect(sets).toEqual([{ video_status: 'failed', video_upload_key: null }]);
    expect(await storage.getPrivate(KEY)).toBeNull();
  }, 30_000);

  it('keeps the status on a non-final failure so the job can retry', async () => {
    const { svc, sets } = setup(processing()); // original missing from storage
    await expect(svc.transcode(1n, KEY, false)).rejects.toThrow('missing');
    expect(sets).toEqual([]);
  });

  it('fails an unreadable file at once, without retries', async () => {
    const { svc, sets, storage } = setup(processing());
    await storage.putPrivate(KEY, Buffer.from('not a video'), 'video/mp4');
    await expect(svc.transcode(1n, KEY, false)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(sets).toEqual([{ video_status: 'failed', video_upload_key: null }]);
  }, 30_000);

  it('only deletes the original when the lesson moved on', async () => {
    const { svc, sets, storage } = setup({
      ...processing(),
      video_upload_key: 'other',
    });
    await putOriginal(storage);
    await svc.transcode(1n, KEY, true);
    expect(sets).toEqual([]);
    expect(await storage.getPrivate(KEY)).toBeNull();
  });

  it('deletePrivatePrefix refuses a prefix outside hls/<id>/<version>/', async () => {
    const { storage } = setup(undefined);
    await expect(storage.deletePrivatePrefix('')).rejects.toThrow();
    await expect(storage.deletePrivatePrefix('hls/')).rejects.toThrow();
    await expect(storage.deletePrivatePrefix('invoices/')).rejects.toThrow();
  });
});

describe('VideoJobs: FFmpeg only on the worker (not in legacy)', () => {
  const make = (rows: { id: bigint; video_upload_key: string }[] = []) => {
    const db = {
      query: { lessons: { findMany: () => Promise.resolve(rows) } },
    } as unknown as Db;
    const jobs = {
      handle: jest.fn(),
      run: jest.fn().mockResolvedValue(undefined),
      enqueue: jest.fn().mockResolvedValue(false),
    };
    const svc = new VideoJobs(
      db,
      {} as StorageService,
      jobs as unknown as JobsService,
    );
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    return { svc, jobs };
  };
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
  });

  it('production web API only queues the transcode, never runs it inline', async () => {
    process.env.NODE_ENV = 'production';
    const { svc, jobs } = make();
    await svc.startTranscode(7n, KEY); // enqueue fails (Redis down)
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'video-transcode',
      { lesson: '7', key: KEY },
      expect.stringMatching(/^video-transcode-7-[0-9a-f]{16}$/),
    );
    expect(jobs.run).not.toHaveBeenCalled();
  });

  it('outside production it may run inline (development without Redis)', async () => {
    process.env.NODE_ENV = 'development';
    const { svc, jobs } = make();
    await svc.startTranscode(7n, KEY);
    expect(jobs.run).toHaveBeenCalledWith(
      'video-transcode',
      { lesson: '7', key: KEY },
      expect.objectContaining({ inline: 'background' }),
    );
  });

  it('the worker sweep queues every upload still processing, with the same job id', async () => {
    const { svc, jobs } = make([
      { id: 7n, video_upload_key: KEY },
      { id: 8n, video_upload_key: 'video-imports/lessons/2/b.mp4' },
    ]);
    jobs.enqueue.mockResolvedValue(true);
    await svc.startTranscode(7n, KEY).catch(() => undefined);
    expect(await svc.sweep()).toBe(2);
    const ids = jobs.enqueue.mock.calls.map((c) => c[2] as string);
    expect(
      new Set(ids.filter((id) => id.startsWith('video-transcode-7-'))).size,
    ).toBe(1);
  });
});

describe('upload token (not in legacy)', () => {
  const g = {
    lesson: '5',
    user: '9',
    filename: 'a.mp4',
    size: 100,
    type: 'video/mp4',
  };
  it('carries the signed grant and expires after 2 h', () => {
    const { token } = signUpload(g, 1_000_000);
    expect(verifyUpload(token, 2_000_000)).toMatchObject(g);
    expect(verifyUpload(token, 1_000_000 + 3 * 3600_000)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...g, size: 1, exp: 9e9 }),
    ).toString('base64url');
    expect(verifyUpload(`${forged}.${sig}`, 2_000_000)).toBeNull();
    expect(verifyUpload(`${payload}.x`, 2_000_000)).toBeNull();
    expect(verifyUpload(undefined)).toBeNull();
  });
  it('the API origin is api.<WEB_URL host> in production', () => {
    expect(
      apiOrigin({ NODE_ENV: 'production', WEB_URL: 'https://bodhiraai.com/' }),
    ).toBe('https://api.bodhiraai.com');
    expect(apiOrigin({ PORT: '4000' })).toBe('http://localhost:4000');
  });
});
