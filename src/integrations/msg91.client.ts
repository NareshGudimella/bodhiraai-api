import { Injectable } from '@nestjs/common';
import { IntegrationSettingsService } from './integration-settings.service';
import { isConfigured, type SmsConfig } from './integrations';

export const DEFAULT_MSG91_API_BASE = 'https://control.msg91.com/api/v5';

/** MSG91_API_BASE: test-only knob (a local stub); never set in production. */
const apiBase = () =>
  (process.env.MSG91_API_BASE || DEFAULT_MSG91_API_BASE).replace(/\/+$/, '');

/** MSG91 wants the number with its country code and no `+`; 10 digits are Indian. */
export function msg91Mobile(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
}

/**
 * not in legacy: MSG91's OTP API (`POST /otp`, DLT template) for phone sign-in
 * codes. Settings: Integrations → SMS (auth key, sender id, template id, enabled).
 */
@Injectable()
export class Msg91Client {
  constructor(private readonly settings: IntegrationSettingsService) {}

  /** The settings when SMS is enabled and complete, else null. */
  async active(): Promise<SmsConfig | null> {
    const cfg = await this.settings.get('sms');
    return isConfigured('sms', cfg) ? cfg : null;
  }

  /** Sends `otp` through the template. Throws on any failure (the auth key is never in the message). */
  async sendOtp(cfg: SmsConfig, phone: string, otp: string): Promise<void> {
    const q = new URLSearchParams({
      template_id: cfg.template_id ?? '',
      mobile: msg91Mobile(phone),
      otp,
    });
    if (cfg.sender_id) q.set('sender', cfg.sender_id);
    const res = await fetch(`${apiBase()}/otp?${q}`, {
      method: 'POST',
      headers: {
        authkey: cfg.auth_key ?? '',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as {
      type?: string;
      message?: string;
    } | null;
    if (!res.ok || json?.type !== 'success')
      throw new Error(
        `MSG91: HTTP ${res.status} ${typeof json?.message === 'string' ? json.message : ''}`.trim(),
      );
  }
}
