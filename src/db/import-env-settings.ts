/**
 * not in legacy (2026-11-25): one-off `npm run settings:import-env`. Copies
 * provider settings that used to live in the environment into the database
 * (Integrations and Mail settings), so switching to panel-only settings is one
 * step. The API no longer reads these variables.
 *
 *   npm run settings:import-env               dry run: prints what would be saved (secrets as "(set)")
 *   npm run settings:import-env -- --apply    saves; needs APP_SECRET when a secret is copied
 *
 * A provider that already has saved settings is skipped (the panel wins), and
 * so is one with nothing set in the environment. Each save is audited.
 *
 *   storage   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
 *             R2_PUBLIC_URL, R2_PRIVATE_BUCKET, R2_LEGACY_BUCKET
 *   payments  BILLING_GATEWAY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
 *             RAZORPAY_WEBHOOK_SECRET, STRIPE_SECRET, STRIPE_WEBHOOK_SECRET,
 *             BILLING_DEMO=1 (→ allow_demo)
 *   ai        ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_MAX_TOKENS, AI_DAILY_TOKEN_LIMIT
 *   vdocipher VDOCIPHER_API_SECRET, VDOCIPHER_VIDEO_ID, VDOCIPHER_PUBLIC_VIDEO_IDS, VDOCIPHER_OTP_TTL
 *   sms       MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_TEMPLATE_ID (saved disabled)
 *   mail      MAIL_MAILER=smtp, MAIL_HOST, MAIL_PORT, MAIL_SCHEME, MAIL_USERNAME,
 *             MAIL_PASSWORD, MAIL_FROM_ADDRESS, MAIL_FROM_NAME
 */
process.env.TZ = 'UTC';

import { loadEnv } from '../config/env';
loadEnv();

import { envString } from '../billing/gateways';
import { AuditService } from '../cms/audit.service';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import {
  isProvider,
  secretFields,
  type Provider,
} from '../integrations/integrations';
import { MailSettingsService } from '../mail/mail-settings.service';
import { createDb } from './db';

type Values = Record<string, string | null>;

/** The environment's values per provider (Laravel env() literals mapped). */
export function envSettings(): Record<Provider | 'mail', Values> {
  const e = (name: string) => envString(name).trim() || null;
  const anyKey = ['RAZORPAY_KEY_ID', 'STRIPE_SECRET'].some((k) => e(k));
  const port = Number(e('MAIL_PORT') ?? 587);
  return {
    storage: {
      account_id: e('R2_ACCOUNT_ID'),
      access_key_id: e('R2_ACCESS_KEY_ID'),
      secret_access_key: e('R2_SECRET_ACCESS_KEY'),
      bucket: e('R2_BUCKET'),
      public_url: e('R2_PUBLIC_URL'),
      private_bucket: e('R2_PRIVATE_BUCKET'),
      video_bucket: e('R2_VIDEO_BUCKET'),
      legacy_bucket: e('R2_LEGACY_BUCKET'),
    },
    sms: {
      enabled: null,
      auth_key: e('MSG91_AUTH_KEY'),
      sender_id: e('MSG91_SENDER_ID'),
      template_id: e('MSG91_TEMPLATE_ID'),
    },
    payments: {
      // Legacy: BILLING_GATEWAY, default razorpay; no keys at all = demo mode.
      gateway:
        e('BILLING_GATEWAY')?.toLowerCase() ?? (anyKey ? 'razorpay' : null),
      razorpay_key_id: e('RAZORPAY_KEY_ID'),
      razorpay_key_secret: e('RAZORPAY_KEY_SECRET'),
      razorpay_webhook_secret: e('RAZORPAY_WEBHOOK_SECRET'),
      stripe_secret: e('STRIPE_SECRET'),
      stripe_webhook_secret: e('STRIPE_WEBHOOK_SECRET'),
      allow_demo: e('BILLING_DEMO') === '1' ? '1' : null,
    },
    ai: {
      api_key: e('ANTHROPIC_API_KEY'),
      model: e('ANTHROPIC_MODEL'),
      max_tokens: e('ANTHROPIC_MAX_TOKENS'),
      daily_token_limit: e('AI_DAILY_TOKEN_LIMIT'),
    },
    vdocipher: {
      api_secret: e('VDOCIPHER_API_SECRET'),
      marketing_video_id: e('VDOCIPHER_VIDEO_ID'),
      public_video_ids: e('VDOCIPHER_PUBLIC_VIDEO_IDS'),
      otp_ttl: e('VDOCIPHER_OTP_TTL'),
    },
    mail:
      e('MAIL_MAILER') === 'smtp'
        ? {
            mailer: 'smtp',
            host: e('MAIL_HOST'),
            port: String(port),
            encryption:
              e('MAIL_SCHEME') === 'smtps' || port === 465 ? 'ssl' : 'none',
            username: e('MAIL_USERNAME'),
            password: e('MAIL_PASSWORD'),
            from_address: e('MAIL_FROM_ADDRESS') ?? 'hello@example.com',
            from_name: e('MAIL_FROM_NAME') ?? 'Bodhira',
          }
        : {},
  };
}

/** What gets printed: secrets as "(set)". */
const shown = (p: Provider | 'mail', v: Values) =>
  Object.fromEntries(
    Object.entries(v).map(([k, val]) => [
      k,
      val !== null &&
      (p === 'mail' ? k === 'password' : secretFields(p).includes(k))
        ? '(set)'
        : val,
    ]),
  );

async function main() {
  const apply = process.argv.includes('--apply');
  const db = createDb();
  const settings = new IntegrationSettingsService(db);
  const mail = new MailSettingsService(db);
  const audit = new AuditService(db);
  const client = { ip: null, userAgent: 'settings:import-env', referer: null };
  console.log(`settings:import-env (${apply ? 'APPLY' : 'dry run'})`);

  for (const [p, values] of Object.entries(envSettings())) {
    if (!Object.values(values).some((v) => v !== null)) {
      console.log(`- ${p}: nothing in the environment, skipped`);
      continue;
    }
    const saved = isProvider(p)
      ? (await settings.view(p)).updated_at
      : (await mail.view()).updated_at;
    if (saved) {
      console.log(`- ${p}: already saved in the panel (${saved}), skipped`);
      continue;
    }
    console.log(
      `- ${p}: ${apply ? 'saving' : 'would save'}`,
      shown(p as Provider, values),
    );
    if (!apply) continue;
    if (isProvider(p)) {
      await settings.save(p, values, null);
      await audit.log(null, client, 'integration_settings.updated', null, {
        provider: p,
        source: 'env',
      });
    } else {
      await mail.save(
        {
          mailer: 'smtp',
          host: values.host,
          port: Number(values.port),
          encryption: values.encryption as 'ssl' | 'none',
          username: values.username,
          password: values.password,
          from_address: values.from_address!,
          from_name: values.from_name,
        },
        null,
      );
      await audit.log(null, client, 'mail_settings.updated', null, {
        source: 'env',
      });
    }
  }
  if (!apply) console.log('Dry run: nothing was saved. Re-run with --apply.');
  else
    console.log(
      'Done. Check Admin → Integrations, then remove the variables from the environment.',
    );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
