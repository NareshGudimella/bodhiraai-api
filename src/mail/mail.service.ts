import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { productionMailProblem, type MailConfig } from './mail-config';
import { MailSettingsService } from './mail-settings.service';

export interface MailMessage {
  to: { address: string; name?: string | null };
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

/** A send that was refused or failed; the message is safe to show a super admin. */
export class MailNotConfigured extends Error {}

/** Error text for display: no credentials, one line, bounded. */
export function sanitizeMailError(e: unknown, cfg?: MailConfig): string {
  let text = e instanceof Error ? e.message : String(e);
  for (const secret of [cfg?.password, cfg?.username]) {
    if (secret && secret.length >= 3) text = text.split(secret).join('***');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || 'Unknown error';
}

/**
 * Laravel's mailers. The settings come from the super admin panel
 * (`mail_settings`, via `MailSettingsService`) and fall back to MAIL_* like
 * config/mail.php when no row exists:
 *  - `log` (Laravel's default): the message is written to the log, nothing is sent.
 *  - `smtp`: nodemailer with the host, port, encryption (`tls` STARTTLS, `ssl`
 *    implicit TLS, or none), username and password.
 *  - `array`: kept in memory (`sent`), for tests (environment only).
 * Send failures throw, as in Laravel.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transport: { key: string; transporter: Transporter } | null = null;
  readonly sent: MailMessage[] = [];

  constructor(private readonly settings: MailSettingsService) {}

  private smtp(cfg: MailConfig): Transporter {
    const key = JSON.stringify([
      cfg.host,
      cfg.port,
      cfg.encryption,
      cfg.username,
      cfg.password,
    ]);
    if (this.transport?.key !== key) {
      this.transport?.transporter.close();
      this.transport = {
        key,
        transporter: createTransport({
          host: cfg.host ?? '127.0.0.1',
          port: cfg.port,
          secure: cfg.encryption === 'ssl',
          requireTLS: cfg.encryption === 'tls',
          auth: cfg.username
            ? { user: cfg.username, pass: cfg.password ?? '' }
            : undefined,
        }),
      };
    }
    return this.transport.transporter;
  }

  async send(message: MailMessage): Promise<void> {
    const cfg = await this.settings.effective();

    // security: not in legacy. In production only a complete `smtp` configuration
    // sends: `log` would write password-reset links (account takeover material)
    // to the log and `array` keeps them in memory. Nothing of the message is logged.
    const problem = productionMailProblem(cfg);
    if (problem) {
      this.logger.error(
        `Outgoing mail is not configured (${problem}): a message was not sent. Set it in the super admin panel (Mail settings).`,
      );
      throw new MailNotConfigured(
        'Outgoing mail is not configured. Ask a super admin to set it up under Mail settings.',
      );
    }

    if (cfg.mailer === 'array') {
      this.sent.push(message);
      return;
    }
    if (cfg.mailer === 'log') {
      const files = (message.attachments ?? []).map((a) => a.filename);
      this.logger.log(
        `To: ${message.to.address} · Subject: ${message.subject}` +
          (files.length ? ` · Attachments: ${files.join(', ')}` : '') +
          `\n${message.text}`,
      );
      return;
    }
    if (cfg.mailer !== 'smtp') {
      throw new Error(`Mailer [${cfg.mailer}] is not defined.`);
    }

    await this.smtp(cfg).sendMail({
      from: { address: cfg.fromAddress, name: cfg.fromName },
      to: message.to.name
        ? { address: message.to.address, name: message.to.name }
        : message.to.address,
      subject: message.subject,
      text: message.text,
      attachments: message.attachments,
    });
  }

  /** not in legacy: the super admin's "Send test email". Never throws; the error is sanitised. */
  async sendTest(
    to: string,
  ): Promise<{ sent: true } | { sent: false; error: string }> {
    const cfg = await this.settings.effective();
    try {
      await this.send({
        to: { address: to },
        subject: 'Bodhira test email',
        text: 'This is a test message from the Bodhira mail settings page. If you can read it, outgoing mail works.',
      });
      return { sent: true };
    } catch (e) {
      const error = sanitizeMailError(e, cfg);
      this.logger.warn(`Test email failed: ${error}`);
      return { sent: false, error };
    }
  }
}
