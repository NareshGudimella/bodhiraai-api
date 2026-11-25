import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { integration_settings, mail_settings } from '../db/schema';
import type { integration_settings as Row } from '../db/types';
import { decryptSecret, encryptSecret, mailKey } from '../mail/mail-crypto';
import {
  coerce,
  defaultsOf,
  fieldsOf,
  isConfigured,
  type Configs,
  type Provider,
} from './integrations';

/**
 * not in legacy: provider settings (R2, MSG91, payment gateways, Anthropic,
 * VdoCipher) stored in `integration_settings`, edited by the super admin.
 * Panel only: the environment is not consulted.
 *
 * Read from the database on every use (a primary-key lookup), like
 * `MailSettingsService`: a save on one API instance applies at once on every
 * instance and the worker, with no cache to invalidate.
 * Secrets are AES-256-GCM with a key derived from APP_SECRET (`mail-crypto.ts`).
 */
@Injectable()
export class IntegrationSettingsService implements OnModuleInit {
  private readonly logger = new Logger('Integrations');

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * security: not in legacy. Production refuses to start without a valid
   * APP_SECRET once any secret is stored (mail password included):
   * the app would otherwise run with providers silently unusable.
   */
  async onModuleInit() {
    if (process.env.NODE_ENV !== 'production') return;
    try {
      mailKey();
    } catch (e) {
      const msg = (e as Error).message;
      if (await this.anySecretStored()) {
        throw new Error(
          `${msg} Stored provider secrets can't be read without it; refusing to start.`,
          { cause: e },
        );
      }
      this.logger.warn(
        `${msg} Secrets can't be saved under Integrations or Mail settings until it is set.`,
      );
    }
  }

  private async anySecretStored() {
    const [a, b] = await Promise.all([
      this.db.$count(
        integration_settings,
        sql`${integration_settings.secrets} <> '{}'::jsonb`,
      ),
      this.db.$count(mail_settings, isNotNull(mail_settings.password_enc)),
    ]);
    return a + b > 0;
  }

  private row(p: Provider): Promise<Row | undefined> {
    return this.db.query.integration_settings.findFirst({
      where: eq(integration_settings.provider, p),
    });
  }

  private config<P extends Provider>(p: P, row: Row | undefined): Configs[P] {
    const out = { ...defaultsOf(p) } as unknown as Record<string, unknown>;
    for (const [name, f] of fieldsOf(p)) {
      if (f.secret) {
        const enc = row?.secrets[name];
        if (!enc) continue;
        try {
          out[name] = decryptSecret(enc);
        } catch {
          // Wrong key or tampered value: treat as unset, never as another value.
          this.logger.error(
            `The stored ${p}.${name} could not be decrypted: check APP_SECRET.`,
          );
        }
      } else if (row && name in row.settings) {
        out[name] = row.settings[name];
      }
    }
    return out as unknown as Configs[P];
  }

  /** The configuration in effect, secrets decrypted. Defaults when nothing is saved. */
  async get<P extends Provider>(p: P): Promise<Configs[P]> {
    return this.config(p, await this.row(p));
  }

  /**
   * What the admin panel shows (the `Item` of /super/integrations): plain
   * values, and for each secret only whether it is set. Never a secret.
   */
  async view(p: Provider) {
    const row = await this.row(p);
    const cfg = this.config(p, row);
    const values: Record<string, unknown> = {};
    const secrets: Record<string, boolean> = {};
    for (const [name, f] of fieldsOf(p)) {
      if (f.secret) secrets[name] = !!row?.secrets[name];
      else values[name] = (cfg as unknown as Record<string, unknown>)[name];
    }
    return {
      provider: p,
      configured: isConfigured(p, cfg),
      updated_at: row?.updated_at.toISOString() ?? null,
      values,
      secrets,
    };
  }

  /**
   * Upserts the provider's row from validated input. Plain fields are replaced;
   * a non-empty secret replaces the stored one, a blank one keeps it.
   * Returns the names of the secrets that changed (never their values).
   * Throws MailKeyError when a secret must be stored without a usable key.
   */
  async save(
    p: Provider,
    input: Record<string, unknown>,
    userId: bigint | null,
  ): Promise<string[]> {
    const existing = await this.row(p);
    const settings: Row['settings'] = {};
    const secrets = { ...existing?.secrets };
    const changed: string[] = [];
    for (const [name, f] of fieldsOf(p)) {
      const v = input[name];
      if (!f.secret) settings[name] = coerce(f, v);
      else if (typeof v === 'string' && v.trim() !== '') {
        secrets[name] = encryptSecret(v.trim());
        changed.push(name);
      }
    }
    await this.write(p, settings, secrets, userId);
    return changed;
  }

  /** Removes one stored secret. Returns false when none was stored. */
  async clear(p: Provider, field: string, userId: bigint | null) {
    const existing = await this.row(p);
    if (!existing?.secrets[field]) return false;
    const secrets = { ...existing.secrets };
    delete secrets[field];
    await this.write(p, existing.settings, secrets, userId);
    return true;
  }

  private async write(
    p: Provider,
    settings: Row['settings'],
    secrets: Row['secrets'],
    userId: bigint | null,
  ) {
    const values = {
      settings,
      secrets,
      updated_by: userId,
      updated_at: new Date(),
    };
    await this.db
      .insert(integration_settings)
      .values({ provider: p, ...values })
      .onConflictDoUpdate({
        target: integration_settings.provider,
        set: values,
      });
  }
}
