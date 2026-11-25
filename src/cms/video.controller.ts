import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { AuthedRequest } from '../common/decorators/auth.decorators';
import { Public } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { RateLimit } from '../common/decorators/rate-limit';
import { DB, type Db } from '../db/db';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import { lessons } from '../db/schema';
import { vdoCipherApiBase } from '../video/vdocipher.client';
import { SettingsService } from './settings.service';

/** config('services.vdocipher.video_id') default; overridden under Integrations → VdoCipher. */
const LEGACY_DEFAULT_VIDEO = 'a69b203eb0fe4c5196ecf06e6261c66c';

/** The CMS setting the home page's video button reads (home.blade.php). */
const HOME_VIDEO_SETTING = 'media.home_video_id';

/** Extra comma-separated marketing video ids (Integrations → VdoCipher). */
const idList = (ids: string | null) =>
  (ids ?? '')
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
 * Settings: Integrations → VdoCipher (API secret, marketing video id, public
 * video ids; not in legacy, 2026-11-25: legacy read the environment).
 *
 * security: not in legacy. Legacy signed an OTP for any 32-hex id, which
 * would let anyone play a lesson video without the paywall. Only marketing
 * videos are served: the marketing video id, the `media.home_video_id` setting and
 * the public video ids, never an id used by a lesson (those play through
 * GET /lessons/:id/playback). Refusals look like the invalid-id reply.
 */
@Controller('video')
@Public()
export class VideoController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly integrations: IntegrationSettingsService,
  ) {}

  @Get('otp')
  @RateLimit(30)
  async otp(
    @Query('video') raw: unknown,
    @Req() req: AuthedRequest,
    @Client() client: ClientInfo,
    @Res() res: Response,
  ) {
    const vdo = await this.integrations.get('vdocipher');
    const defaultVideo = vdo.marketing_video_id || LEGACY_DEFAULT_VIDEO;
    const videoId = typeof raw === 'string' ? raw : defaultVideo;
    // VdoCipher ids are 32 hex chars — reject anything else.
    if (
      !/^[a-f0-9]{32}$/i.test(videoId) ||
      !(await this.isPublic(videoId, [
        defaultVideo,
        ...idList(vdo.public_video_ids),
      ]))
    ) {
      res.status(422).json({ error: 'invalid_video_id' });
      return;
    }
    // Traceable watermark: the signed-in viewer's email, else IP · time.
    const watermark =
      req.user?.email ?? `${client.ip ?? ''} · ${dMYHi(new Date())}`;
    const data = await this.fetchOtp(vdo.api_secret, videoId, 300, watermark);
    if (!data) {
      res.status(502).json({ error: 'unavailable' });
      return;
    }
    res.status(200).json(data);
  }

  /** security: not in legacy. A marketing video id that no lesson uses. */
  private async isPublic(videoId: string, allowed: string[]): Promise<boolean> {
    const id = videoId.toLowerCase();
    const home = await this.settings.get(HOME_VIDEO_SETTING);
    if (typeof home === 'string') allowed.push(home);
    if (!allowed.some((a) => a.toLowerCase() === id)) return false;
    const lessonVideo = await this.db
      .select({ id: lessons.id })
      .from(lessons)
      .where(sql`lower(${lessons.video_id}) = ${id}`)
      .limit(1);
    return lessonVideo.length === 0;
  }

  private async fetchOtp(
    secret: string | null,
    videoId: string,
    ttl: number,
    watermark: string,
  ) {
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
