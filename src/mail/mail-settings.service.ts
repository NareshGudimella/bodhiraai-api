import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { mail_settings } from '../db/schema';
import type { mail_settings as MailSettingsRow } from '../db/types';
import { envMailConfig, type MailConfig } from './mail-config';
import { decryptSecret, encryptSecret, mailKey } from './mail-crypto';

export interface MailSettingsInput {
  mailer: 'smtp' | 'log';
  host: string | null;
  port: number | null;
  encryption: 'tls' | 'ssl' | 'none' | null;
  username: string | null;
  /** null/empty keeps the stored password. */
  password: string | null;
  from_address: string;
  from_name: string | null;
}

/** Re-read the row at least this often, so other instances pick up a save. */
const CACHE_MS = 60_000;

/**
 * not in legacy: outgoing-mail settings stored in `mail_settings` (one row),
 * cached in memory (dropped on save here, and every minute for other instances).
 * With no row, the MAIL_* environment applies, so existing deploys keep working.
 */
@Injectable()
export class MailSettingsService implements OnModuleInit {
  private readonly logger = new Logger('MailSettings');
  private cache: { at: number; cfg: MailConfig } | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'production') {
      try {
        mailKey();
      } catch (e) {
        this.logger.warn(
          `${(e as Error).message} The SMTP password can't be saved in the admin panel until it is set.`,
        );
      }
    }
  }

  invalidate() {
    this.cache = null;
  }

  private row(): Promise<MailSettingsRow | undefined> {
    return this.db.query.mail_settings.findFirst({
      where: eq(mail_settings.id, 1),
    });
  }

  private toConfig(row: MailSettingsRow): MailConfig {
    let password: string | null = null;
    if (row.password_enc) {
      try {
        password = decryptSecret(row.password_enc);
      } catch {
        // Wrong or missing key: send without a password (the SMTP server will
        // refuse) rather than quietly using different credentials.
        this.logger.error(
          'The stored SMTP password could not be decrypted: check MAIL_SETTINGS_KEY.',
        );
      }
    }
    return {
      source: 'database',
      mailer: row.mailer,
      host: row.host,
      port: row.port ?? 587,
      encryption: (row.encryption as MailConfig['encryption']) ?? 'none',
      username: row.username,
      password,
      fromAddress: row.from_address,
      fromName: row.from_name ?? '',
    };
  }

  /** The configuration in effect: the saved row, else the environment. */
  async effective(): Promise<MailConfig> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) {
      return this.cache.cfg;
    }
    const row = await this.row();
    const cfg = row ? this.toConfig(row) : envMailConfig();
    this.cache = { at: Date.now(), cfg };
    return cfg;
  }

  /** What the admin form shows. Never includes the password. */
  async view() {
    const row = await this.row();
    if (!row) {
      const env = envMailConfig();
      return {
        source: 'env' as const,
        mailer: env.mailer === 'smtp' ? 'smtp' : 'log',
        host: env.host,
        port: env.port,
        encryption: env.encryption,
        username: env.username,
        password_set: !!env.password,
        from_address: env.fromAddress,
        from_name: env.fromName || null,
        updated_at: null,
        updated_by: null,
      };
    }
    return {
      source: 'database' as const,
      mailer: row.mailer,
      host: row.host,
      port: row.port,
      encryption: row.encryption ?? 'none',
      username: row.username,
      password_set: !!row.password_enc,
      from_address: row.from_address,
      from_name: row.from_name,
      updated_at: row.updated_at.toISOString(),
      updated_by: row.updated_by,
    };
  }

  /** Upserts the row. Returns whether the password changed. */
  async save(input: MailSettingsInput, userId: bigint) {
    const existing = await this.row();
    let password_enc = existing?.password_enc ?? null;
    if (input.password) {
      password_enc = encryptSecret(input.password); // MailKeyError without a key
    } else if (!existing && process.env.MAIL_PASSWORD) {
      // First save: keep the password the environment was using.
      try {
        password_enc = encryptSecret(process.env.MAIL_PASSWORD);
      } catch {
        password_enc = null;
      }
    }
    const values = {
      mailer: input.mailer,
      host: input.host,
      port: input.port,
      encryption: input.encryption ?? 'none',
      username: input.username,
      password_enc,
      from_address: input.from_address,
      from_name: input.from_name,
      updated_by: userId,
      updated_at: new Date(),
    };
    await this.db
      .insert(mail_settings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: mail_settings.id, set: values });
    this.invalidate();
    return { password_changed: !!input.password };
  }
}
