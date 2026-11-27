import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * not in legacy: lesson video to AES-128 encrypted HLS VOD with the `ffmpeg`
 * and `ffprobe` binaries on PATH (docs/video-hls-contract.md). Renditions 360p
 * and 720p, MPEG-TS segments of 6 s; never upscaled.
 */
export const RENDITIONS = [
  { name: '360p', height: 360, video: 800, audio: 96 },
  { name: '720p', height: 720, video: 2500, audio: 128 },
] as const;

export interface Rendition {
  name: string;
  width: number;
  height: number;
  /** Video + audio, kbit/s. */
  kbps: number;
  videoKbps: number;
  audioKbps: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Renditions the source can fill: 720p only from a source at least 720 high,
 * 360p from 360. A smaller source gets one "360p" rendition at its own size
 * (the file names stay fixed for the players).
 */
export function chooseRenditions(width: number, height: number): Rendition[] {
  const make = (r: (typeof RENDITIONS)[number], h: number): Rendition => ({
    name: r.name,
    height: even(h),
    width: even((width * h) / height),
    kbps: r.video + r.audio,
    videoKbps: r.video,
    audioKbps: r.audio,
  });
  const fit = RENDITIONS.filter((r) => height >= r.height);
  if (fit.length === 0) return [make(RENDITIONS[0], height)];
  return fit.map((r) => make(r, r.height));
}

export function masterPlaylist(renditions: Rendition[]): string {
  return (
    '#EXTM3U\n#EXT-X-VERSION:3\n' +
    renditions
      .map(
        (r) =>
          `#EXT-X-STREAM-INF:BANDWIDTH=${r.kbps * 1000},RESOLUTION=${r.width}x${r.height}\n${r.name}.m3u8\n`,
      )
      .join('')
  );
}

/** The file is not a readable video: retrying cannot help. */
export class UnreadableVideo extends Error {}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on(
      'data',
      (d: Buffer) => (err = (err + d.toString()).slice(-2000)),
    );
    p.on('error', (e) =>
      reject(new Error(`${cmd} could not start: ${e.message}`)),
    );
    p.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} exited with ${code}: ${err.trim()}`)),
    );
  });
}

/** Width and height of the first video stream. Throws when there is none. */
export async function probeSize(file: string) {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:stream_side_data=rotation:format=duration',
    '-of',
    'json',
    file,
  ]).catch((e: Error) => {
    // ffprobe ran and rejected the file (a missing binary stays a retryable error)
    throw /exited with/.test(e.message) ? new UnreadableVideo(e.message) : e;
  });
  const parsed = JSON.parse(out) as {
    streams?: {
      width?: number;
      height?: number;
      side_data_list?: { rotation?: number }[];
    }[];
    format?: { duration?: string };
  };
  const s = parsed.streams?.[0];
  // not in legacy: the real length, so lesson progress uses it (not a typed-in value).
  const duration = Math.round(Number(parsed.format?.duration) || 0);
  if (!s?.width || !s.height)
    throw new UnreadableVideo('The file has no video stream');
  // A phone clip rotated by 90 degrees is displayed (and scaled by ffmpeg) with sides swapped.
  const turned = Math.abs(s.side_data_list?.[0]?.rotation ?? 0) % 180 === 90;
  return turned
    ? { width: s.height, height: s.width, duration }
    : { width: s.width, height: s.height, duration };
}

export interface HlsFile {
  name: string;
  /** On disk, in the temp dir; deleted after `transcodeToHls` returns. */
  path: string;
  contentType: string;
}

/**
 * Free space needed to transcode a `size`-byte original: the output is about
 * 1.5 times it, plus the original itself when it has to be downloaded.
 */
export async function assertDiskSpace(
  dir: string,
  size: number,
  downloaded: boolean,
) {
  const need = Math.ceil(size * (downloaded ? 2.5 : 1.5));
  const s = await statfs(dir);
  const free = s.bavail * s.bsize;
  if (free < need)
    throw new Error(
      `Not enough free disk space to transcode: ${Math.ceil(need / 1e9)} GB needed in ${dir}, ${Math.floor(free / 1e9)} GB free`,
    );
}

/**
 * Transcodes the video file at `src` and hands each encrypted HLS file (on
 * disk) to `upload` one by one; returns the raw 16-byte AES-128 key. Nothing
 * is held in memory. The temp dir is always removed. Segment names are
 * `<rendition>_%05d.ts`; playlists carry `#EXT-X-KEY` with the placeholder URI
 * `key` (rewritten per request by the API) and a random IV.
 */
export async function transcodeToHls(
  src: string,
  upload: (file: HlsFile) => Promise<void>,
): Promise<{ key: Buffer; durationSec: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'bodhira-hls-'));
  try {
    const { width, height, duration } = await probeSize(src);
    const renditions = chooseRenditions(width, height);

    const key = randomBytes(16);
    const keyFile = join(dir, 'enc.key');
    const infoFile = join(dir, 'enc.keyinfo');
    await writeFile(keyFile, key);
    // line 1: URI written into the playlist; 2: key file; 3: the IV
    await writeFile(
      infoFile,
      `key\n${keyFile}\n${randomBytes(16).toString('hex')}\n`,
    );

    for (const r of renditions) {
      await run('ffmpeg', [
        '-y',
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        src,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        `scale=${r.width}:${r.height}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-profile:v',
        'main',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        `${r.videoKbps}k`,
        '-maxrate',
        `${Math.round(r.videoKbps * 1.07)}k`,
        '-bufsize',
        `${r.videoKbps * 2}k`,
        '-sc_threshold',
        '0',
        '-force_key_frames',
        'expr:gte(t,n_forced*6)',
        '-c:a',
        'aac',
        '-b:a',
        `${r.audioKbps}k`,
        '-ac',
        '2',
        '-f',
        'hls',
        '-hls_time',
        '6',
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
        '-hls_key_info_file',
        infoFile,
        '-hls_segment_filename',
        join(dir, `${r.name}_%05d.ts`),
        join(dir, `${r.name}.m3u8`),
      ]);
    }
    await writeFile(join(dir, 'master.m3u8'), masterPlaylist(renditions));

    for (const name of (await readdir(dir)).sort()) {
      if (!/\.(m3u8|ts)$/.test(name)) continue;
      await upload({
        name,
        path: join(dir, name),
        contentType: name.endsWith('.ts')
          ? 'video/mp2t'
          : 'application/vnd.apple.mpegurl',
      });
    }
    return { key, durationSec: duration };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
