import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { mail_settings } from '../db/schema';
import type { mail_settings as MailSettingsRow } from '../db/types';
import { defaultMailConfig, type MailConfig } from './mail-config';
import { decryptSecret, encryptSecret } from './mail-crypto';

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

/**
 * not in legacy: outgoing-mail settings stored in `mail_settings` (one row).
 * Read on every send (a primary-key lookup; mail is rare), so a save on one
 * API instance applies at once on every instance and the worker.
 * With no row, the `log` mailer applies (production refuses to send). Panel
 * only since 2026-11-25: MAIL_* is not read (`npm run settings:import-env`).
 * The boot check for APP_SECRET is in IntegrationSettingsService.
 */
@Injectable()
export class MailSettingsService {
  private readonly logger = new Logger('MailSettings');

  constructor(@Inject(DB) private readonly db: Db) {}

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
          'The stored SMTP password could not be decrypted: check APP_SECRET.',
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

  /** The configuration in effect: the saved row, else the defaults. */
  async effective(): Promise<MailConfig> {
    const row = await this.row();
    return row ? this.toConfig(row) : defaultMailConfig();
  }

  /** What the admin form shows. Never includes the password. */
  async view() {
    const row = await this.row();
    if (!row) {
      const d = defaultMailConfig();
      return {
        source: 'none' as const,
        mailer: 'log',
        host: d.host,
        port: d.port,
        encryption: d.encryption,
        username: d.username,
        password_set: false,
        from_address: d.fromAddress,
        from_name: d.fromName,
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
  async save(input: MailSettingsInput, userId: bigint | null) {
    const existing = await this.row();
    let password_enc = existing?.password_enc ?? null;
    if (input.password) {
      password_enc = encryptSecret(input.password); // MailKeyError without a key
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
    return { password_changed: !!input.password };
  }

  /** not in legacy: removes the stored SMTP password. Returns false when none was stored. */
  async clearPassword(userId: bigint) {
    const row = await this.row();
    if (!row?.password_enc) return false;
    await this.db
      .update(mail_settings)
      .set({ password_enc: null, updated_by: userId, updated_at: new Date() })
      .where(eq(mail_settings.id, 1));
    return true;
  }
}
