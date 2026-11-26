import {
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { Public } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { RateLimit } from '../common/decorators/rate-limit';
import { ApiException } from '../common/http/api.exception';
import { forbidden, routeId } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { lessons, video_sessions } from '../db/schema';
import { decryptSecret } from '../mail/mail-crypto';
import { filesBaseUrl, signFileKey } from '../storage/file-url';
import { StorageService } from '../storage/storage.service';
import { verifyHlsToken } from './hls-token';
import { MAX_KEY_FETCHES } from './video-session';

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
  private readonly logger = new Logger('HlsKey');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /**
   * The lesson's HLS prefix and key, for a valid token; 403 / 404 otherwise.
   * Strict playback protection: the session must be unrevoked and before its
   * `key_deadline`; with `consume` (the key route) the fetch counter is bumped
   * in the same single UPDATE ... RETURNING, so the key is served at most 3 times.
   */
  private async authorise(raw: string, t: unknown, consume = false) {
    const id = routeId(raw, 'Lesson');
    const tok = verifyHlsToken(id, t);
    if (tok === null) throw forbidden();
    const { exp } = tok;
    const open = and(
      eq(video_sessions.id, tok.session),
      eq(video_sessions.lesson_id, id),
      eq(video_sessions.user_id, tok.user),
      isNull(video_sessions.revoked_at),
      // The app clock, not now(): the columns are timestamp without time zone.
      gt(video_sessions.key_deadline, new Date()),
    );
    const [session] = consume
      ? await this.db
          .update(video_sessions)
          .set({ key_fetches: sql`${video_sessions.key_fetches} + 1` })
          .where(and(open, lt(video_sessions.key_fetches, MAX_KEY_FETCHES)))
          .returning({ id: video_sessions.id })
      : await this.db
          .select({ id: video_sessions.id })
          .from(video_sessions)
          .where(open);
    if (!session) throw forbidden();
    const lesson = await this.db.query.lessons.findFirst({
      where: eq(lessons.id, id),
      columns: { video_hls_path: true, video_hls_key: true },
    });
    if (!lesson?.video_hls_path || !lesson.video_hls_key)
      throw new ApiException('Not found.', 404);
    return {
      id,
      exp,
      user: tok.user,
      session: tok.session,
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
    @Client() client: ClientInfo,
    @Res() res: Response,
  ) {
    const { enc, id, user, session } = await this.authorise(raw, t, true);
    this.logger.log(
      `key fetch session=${session} user=${user} lesson=${id} ip=${client.ip}`,
    );
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
