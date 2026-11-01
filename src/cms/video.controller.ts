import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthedRequest } from '../common/decorators/auth.decorators';
import { Public } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { RateLimit } from '../common/decorators/rate-limit';
import { envString } from '../billing/gateways';
import { vdoCipherApiBase } from '../video/vdocipher.client';

/** config('services.vdocipher.video_id'). */
const DEFAULT_VIDEO = () =>
  envString('VDOCIPHER_VIDEO_ID') || 'a69b203eb0fe4c5196ecf06e6261c66c';

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
 */
@Controller('video')
@Public()
export class VideoController {
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
    if (!/^[a-f0-9]{32}$/i.test(videoId)) {
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
