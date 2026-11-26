import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import { Public } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit';
import { ApiException } from '../common/http/api.exception';
import { forbidden, routeId } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { lessons } from '../db/schema';
import { decryptSecret } from '../mail/mail-crypto';
import { filesBaseUrl, signFileKey } from '../storage/file-url';
import { StorageService } from '../storage/storage.service';
import { verifyHlsToken } from './hls-token';

const PLAYLISTS = ['master.m3u8', '360p.m3u8', '720p.m3u8'];
const SEGMENT = /^[A-Za-z0-9_-]+\.ts$/;

/**
 * not in legacy: serves a self-hosted lesson video (docs/video-hls-contract.md).
 * No Bearer: the `t` token (HMAC with the `video` key, see hls-token.ts)
 * authorises, because native players can't send headers. Playlists are
 * rewritten per request: variants point back here, segments become signed
 * private-file links (`/files/hls/…`, same expiry as the token) and the
 * `#EXT-X-KEY` URI points at the key route.
 */
@Controller('lessons/:lesson/hls')
@Public()
export class HlsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /** The lesson's HLS prefix and key, for a valid token; 403 / 404 otherwise. */
  private async authorise(raw: string, t: unknown) {
    const id = routeId(raw, 'Lesson');
    const exp = verifyHlsToken(id, t);
    if (exp === null) throw forbidden();
    const lesson = await this.db.query.lessons.findFirst({
      where: eq(lessons.id, id),
      columns: { video_hls_path: true, video_hls_key: true },
    });
    if (!lesson?.video_hls_path || !lesson.video_hls_key)
      throw new ApiException('Not found.', 404);
    return {
      id,
      exp,
      prefix: lesson.video_hls_path,
      enc: lesson.video_hls_key,
    };
  }

  // Declared before `:file`, so `key` isn't taken for a playlist name.
  @Get('key')
  @RateLimit(120, 'ip')
  async key(
    @Param('lesson') raw: string,
    @Query('t') t: unknown,
    @Res() res: Response,
  ) {
    const { enc } = await this.authorise(raw, t);
    const key = Buffer.from(decryptSecret(enc), 'base64');
    res
      .status(200)
      .set({
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': String(key.length),
      })
      .end(key);
  }

  @Get(':file')
  @RateLimit(300, 'ip')
  async playlist(
    @Param('lesson') raw: string,
    @Param('file') file: string,
    @Query('t') t: unknown,
    @Res() res: Response,
  ) {
    if (!PLAYLISTS.includes(file)) throw new ApiException('Not found.', 404);
    const { id, exp, prefix } = await this.authorise(raw, t);
    const bytes = await this.storage.getPrivate(`${prefix}${file}`);
    if (!bytes) throw new ApiException('Not found.', 404);

    const base = `${filesBaseUrl()}/api/v1/lessons/${id}/hls`;
    const token = encodeURIComponent(t as string);
    const ttl = Math.max(1, exp - Math.floor(Date.now() / 1000));
    const body = bytes
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => {
        if (line.startsWith('#EXT-X-KEY'))
          return line.replace(/URI="[^"]*"/, `URI="${base}/key?t=${token}"`);
        if (line === '' || line.startsWith('#')) return line;
        if (PLAYLISTS.includes(line)) return `${base}/${line}?t=${token}`;
        if (!SEGMENT.test(line)) throw new Error(`Unexpected playlist entry`);
        return signFileKey(`${prefix}${line}`, { ttl });
      })
      .join('\n');
    res
      .status(200)
      .set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'private, no-store',
      })
      .send(body);
  }
}
