import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { AuthedRequest } from '../common/decorators/auth.decorators';
import { Public } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { RateLimit } from '../common/decorators/rate-limit';
import { envString } from '../billing/gateways';
import { DB, type Db } from '../db/db';
import { lessons } from '../db/schema';
import { vdoCipherApiBase } from '../video/vdocipher.client';
import { SettingsService } from './settings.service';

/** config('services.vdocipher.video_id'). */
const DEFAULT_VIDEO = () =>
  envString('VDOCIPHER_VIDEO_ID') || 'a69b203eb0fe4c5196ecf06e6261c66c';

/** The CMS setting the home page's video button reads (home.blade.php). */
const HOME_VIDEO_SETTING = 'media.home_video_id';

/** VDOCIPHER_PUBLIC_VIDEO_IDS: extra comma-separated marketing video ids. */
const extraPublicIds = () =>
  envString('VDOCIPHER_PUBLIC_VIDEO_IDS')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const pad = (n: number) => String(n).padStart(2, '0');
/** Carbon format('d M Y H:i'). */
const dMYHi = (d: Date) =>
  `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

/**
 * Port of VideoController::otp + VdoCipherService::otp: a fresh playback OTP
 * for the marketing site's secure video, fetched when the visitor clicks
 * play. Same bare JSON replies as legacy (not the API envelope).
 * VDOCIPHER_API_SECRET, VDOCIPHER_VIDEO_ID (default video), VDOCIPHER_WATERMARK.
 *
 * security: not in legacy. Legacy signed an OTP for any 32-hex id, which
 * would let anyone play a lesson video without the paywall. Only marketing
 * videos are served: VDOCIPHER_VIDEO_ID, the `media.home_video_id` setting and
 * VDOCIPHER_PUBLIC_VIDEO_IDS, never an id used by a lesson (those play through
 * GET /lessons/:id/playback). Refusals look like the invalid-id reply.
 */
@Controller('video')
@Public()
export class VideoController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  @Get('otp')
  @RateLimit(30)
  async otp(
    @Query('video') raw: unknown,
    @Req() req: AuthedRequest,
    @Client() client: ClientInfo,
    @Res() res: Response,
  ) {
    const videoId = typeof raw === 'string' ? raw : DEFAULT_VIDEO();
    // VdoCipher ids are 32 hex chars — reject anything else.
    if (!/^[a-f0-9]{32}$/i.test(videoId) || !(await this.isPublic(videoId))) {
      res.status(422).json({ error: 'invalid_video_id' });
      return;
    }
    // Traceable watermark: the signed-in viewer's email, else IP · time.
    const watermark =
      req.user?.email ?? `${client.ip ?? ''} · ${dMYHi(new Date())}`;
    const data = await this.fetchOtp(videoId, 300, watermark);
    if (!data) {
      res.status(502).json({ error: 'unavailable' });
      return;
    }
    res.status(200).json(data);
  }

  /** security: not in legacy. A marketing video id that no lesson uses. */
  private async isPublic(videoId: string): Promise<boolean> {
    const id = videoId.toLowerCase();
    const home = await this.settings.get(HOME_VIDEO_SETTING);
    const allowed = [DEFAULT_VIDEO(), ...extraPublicIds()];
    if (typeof home === 'string') allowed.push(home);
    if (!allowed.some((a) => a.toLowerCase() === id)) return false;
    const lessonVideo = await this.db
      .select({ id: lessons.id })
      .from(lessons)
      .where(sql`lower(${lessons.video_id}) = ${id}`)
      .limit(1);
    return lessonVideo.length === 0;
  }

  private async fetchOtp(videoId: string, ttl: number, watermark: string) {
    const secret = envString('VDOCIPHER_API_SECRET');
    if (!secret) return null;
    const payload: Record<string, unknown> = { ttl };
    const text = watermark;
    if (text !== '') {
      payload.annotate = JSON.stringify([
        {
          type: 'rtext',
          text,
          alpha: '0.50',
          color: '0xFFFFFF',
          size: '16',
          interval: '8000',
        },
      ]);
    }
    try {
      const res = await fetch(
        // VDOCIPHER_API_BASE (not in legacy) lets tests use a local stub.
        `${vdoCipherApiBase()}/videos/${videoId}/otp`,
        {
          method: 'POST',
          headers: {
            Authorization: `Apisecret ${secret}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const json = (await res.json().catch(() => null)) as {
        otp?: string;
        playbackInfo?: string;
      } | null;
      if (!res.ok || !json?.otp) return null;
      return { otp: json.otp, playbackInfo: json.playbackInfo };
    } catch {
      return null;
    }
  }
}
