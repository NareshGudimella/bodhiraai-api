import { Injectable, Logger } from '@nestjs/common';
import { envString } from '../billing/gateways';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';

/**
 * security: not in legacy. VdoCipher API client for lesson videos (DRM and a
 * moving watermark; contract: protected media, 2026-11-01).
 *
 * Settings (not in legacy, 2026-11-25): Integrations → VdoCipher, read per call:
 *   API secret  (required in production for video uploads)
 *   OTP TTL     playback OTP lifetime in seconds, default 300
 * VDOCIPHER_API_BASE (env, test-only knob): default https://dev.vdocipher.com/api.
 *
 * Without a secret outside production, lesson video uploads fall back to
 * private storage and play through a signed link (`provider: 'url'`).
 */
export const DEFAULT_VDOCIPHER_API_BASE = 'https://dev.vdocipher.com/api';

export class VdoCipherError extends Error {}

/** VdoCipher video ids are 32 hex characters. */
export const isVideoId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id);

export function vdoCipherApiBase(): string {
  return (
    envString('VDOCIPHER_API_BASE') || DEFAULT_VDOCIPHER_API_BASE
  ).replace(/\/+$/, '');
}

/** Playback OTP lifetime: the saved TTL (30 s – 24 h), default 300. */
export function vdoCipherOtpTtl(saved: number | null): number {
  return saved && saved > 0 ? Math.min(saved, 86_400) : 300;
}

interface UploadCredentials {
  clientPayload: {
    policy: string;
    key: string;
    'x-amz-signature': string;
    'x-amz-algorithm': string;
    'x-amz-date': string;
    'x-amz-credential': string;
    uploadLink: string;
  };
  videoId: string;
}

@Injectable()
export class VdoCipherClient {
  private readonly logger = new Logger(VdoCipherClient.name);

  constructor(private readonly settings: IntegrationSettingsService) {}

  private async secret(): Promise<string | null> {
    return (await this.settings.get('vdocipher')).api_secret || null;
  }

  /** True when the API secret is set. */
  async configured(): Promise<boolean> {
    return (await this.secret()) !== null;
  }

  /** not in legacy: the super admin's "Test": an authenticated list of one video. */
  async test(): Promise<void> {
    await this.call('GET', '/videos?page=1&limit=1');
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    const secret = await this.secret();
    if (!secret) throw new VdoCipherError('VdoCipher is not configured');
    let res: Response;
    try {
      res = await fetch(`${vdoCipherApiBase()}${path}`, {
        method,
        headers: {
          Authorization: `Apisecret ${secret}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new VdoCipherError(`VdoCipher ${method} ${path}: ${String(e)}`);
    }
    const json = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || json === null)
      throw new VdoCipherError(
        `VdoCipher ${method} ${path}: HTTP ${res.status}`,
      );
    return json;
  }

  /**
   * A playback OTP for `videoId`, with a moving-text watermark (the viewer's
   * name and phone or email): alpha 0.6, size 15, every 5 s.
   */
  async otp(
    videoId: string,
    watermark: string,
    ttl?: number,
  ): Promise<{ otp: string; playbackInfo: string; ttl: number }> {
    if (!isVideoId(videoId)) throw new VdoCipherError('Invalid video id');
    ttl ??= vdoCipherOtpTtl((await this.settings.get('vdocipher')).otp_ttl);
    const json = await this.call<{ otp?: string; playbackInfo?: string }>(
      'POST',
      `/videos/${videoId}/otp`,
      {
        ttl,
        annotate: JSON.stringify([
          {
            type: 'rtext',
            text: watermark,
            alpha: '0.60',
            color: '0xFFFFFF',
            size: '15',
            interval: '5000',
          },
        ]),
      },
    );
    if (!json.otp || !json.playbackInfo)
      throw new VdoCipherError('VdoCipher OTP response without otp');
    return { otp: json.otp, playbackInfo: json.playbackInfo, ttl };
  }

  /**
   * Upload a video: PUT /videos?title= for upload credentials, then the
   * multipart POST to `uploadLink` (policy fields, success_action_status=201,
   * the file last). Returns the new video id.
   */
  async upload(
    bytes: Buffer,
    fileName: string,
    contentType: string,
    title: string,
  ): Promise<string> {
    const creds = await this.call<UploadCredentials>(
      'PUT',
      `/videos?title=${encodeURIComponent(title.slice(0, 200) || 'Lesson')}`,
    );
    const p = creds.clientPayload;
    if (!isVideoId(creds.videoId) || !p?.uploadLink)
      throw new VdoCipherError('VdoCipher upload credentials incomplete');
    const form = new FormData();
    form.append('policy', p.policy);
    form.append('key', p.key);
    form.append('x-amz-signature', p['x-amz-signature']);
    form.append('x-amz-algorithm', p['x-amz-algorithm']);
    form.append('x-amz-date', p['x-amz-date']);
    form.append('x-amz-credential', p['x-amz-credential']);
    form.append('success_action_status', '201');
    form.append('success_action_redirect', '');
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: contentType }),
      fileName,
    );
    let res: Response;
    try {
      res = await fetch(p.uploadLink, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch (e) {
      throw new VdoCipherError(`VdoCipher upload: ${String(e)}`);
    }
    if (res.status !== 201 && !res.ok)
      throw new VdoCipherError(`VdoCipher upload: HTTP ${res.status}`);
    return creds.videoId;
  }

  /** Import a video from a (presigned) URL. Returns the new video id. */
  async importUrl(url: string, title: string): Promise<string> {
    const json = await this.call<{ id?: string }>(
      'PUT',
      '/videos/importUrl',
      { url, title: title.slice(0, 200) || 'Lesson' },
      60_000,
    );
    if (!isVideoId(json.id))
      throw new VdoCipherError('VdoCipher importUrl response without id');
    return json.id;
  }

  /** not in legacy: a video's processing status (`ready` once playable). */
  async status(videoId: string): Promise<string> {
    if (!isVideoId(videoId)) throw new VdoCipherError('Invalid video id');
    const json = await this.call<{ status?: unknown }>(
      'GET',
      `/videos/${videoId}`,
    );
    return typeof json.status === 'string' ? json.status : '';
  }

  /** Delete videos; throws on failure (the `video-delete` job retries). */
  async delete(...ids: (string | null | undefined)[]) {
    const valid = ids.filter(isVideoId);
    if (!valid.length || !(await this.configured())) return;
    await this.call('DELETE', `/videos?videos=${valid.join(',')}`);
  }

  /** Delete videos, best-effort: failures are logged, never thrown. */
  async deleteBestEffort(...ids: (string | null | undefined)[]) {
    try {
      await this.delete(...ids);
    } catch (e) {
      this.logger.warn(`Could not delete VdoCipher video(s): ${String(e)}`);
    }
  }
}
