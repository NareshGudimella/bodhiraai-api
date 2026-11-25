/**
 * not in legacy: the providers configured in the super admin panel
 * (Integrations), their fields and validation. Legacy (and this API until
 * 2026-11-25) read these from the environment; now only the panel counts.
 * Test-only knobs stay in the environment and can't be set here:
 * STORAGE_DRIVER, R2_ENDPOINT, VDOCIPHER_API_BASE, MSG91_API_BASE,
 * ANTHROPIC_BASE_URL (read by the Anthropic SDK).
 */

type Value = string | number | boolean | null;

interface FieldDef {
  /** Write-only: stored encrypted, never returned (`<field>_set` instead). */
  secret?: true;
  type?: 'int' | 'bool';
  /** Laravel rules for PUT (laravelValidate). */
  rules: string[];
  default?: Value;
}

const str = (max: number) => ['nullable', 'string', `max:${max}`];
const secret = (max = 500): FieldDef => ({ secret: true, rules: str(max) });
const BUCKET = [...str(63), 'regex:/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/'];
const VIDEO_ID = ['nullable', 'string', 'regex:/^[a-fA-F0-9]{32}$/'];

export const PROVIDERS = {
  /** Cloudflare R2 (used when STORAGE_DRIVER=r2). */
  storage: {
    account_id: { rules: [...str(64), 'regex:/^[A-Za-z0-9]+$/'] },
    access_key_id: { rules: str(190) },
    secret_access_key: secret(),
    bucket: { rules: BUCKET },
    public_url: { rules: ['nullable', 'url', 'max:190'] },
    private_bucket: { rules: [...BUCKET, 'different:bucket'] },
    legacy_bucket: { rules: BUCKET },
  },
  /** MSG91 OTP API: phone sign-in codes. */
  sms: {
    enabled: { type: 'bool', rules: ['required', 'boolean'], default: false },
    auth_key: secret(200),
    sender_id: { rules: [...str(11), 'regex:/^[A-Za-z0-9]+$/'] },
    template_id: {
      rules: ['required_if:enabled,1', ...str(64), 'regex:/^[A-Za-z0-9]+$/'],
    },
  },
  payments: {
    gateway: {
      rules: ['required', 'in:razorpay,stripe,none'],
      default: 'none',
    },
    razorpay_key_id: { rules: [...str(190), 'regex:/^rzp_[A-Za-z0-9_]+$/'] },
    razorpay_key_secret: secret(),
    razorpay_webhook_secret: secret(),
    stripe_secret: secret(),
    stripe_webhook_secret: secret(),
  },
  /** The AI tutor (Anthropic). */
  ai: {
    api_key: secret(),
    model: { rules: [...str(100), 'regex:/^[A-Za-z0-9._:@-]+$/'] },
    max_tokens: {
      type: 'int',
      rules: ['nullable', 'integer', 'min:1', 'max:64000'],
    },
    daily_token_limit: {
      type: 'int',
      rules: ['nullable', 'integer', 'min:1', 'max:100000000'],
    },
  },
  vdocipher: {
    api_secret: secret(),
    marketing_video_id: { rules: VIDEO_ID },
    public_video_ids: {
      rules: [
        ...str(2000),
        'regex:/^\\s*[a-fA-F0-9]{32}(\\s*,\\s*[a-fA-F0-9]{32})*\\s*$/',
      ],
    },
    otp_ttl: {
      type: 'int',
      rules: ['nullable', 'integer', 'min:30', 'max:86400'],
    },
  },
} satisfies Record<string, Record<string, FieldDef>>;

export type Provider = keyof typeof PROVIDERS;
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as Provider[];
export const isProvider = (p: unknown): p is Provider =>
  typeof p === 'string' && Object.hasOwn(PROVIDERS, p);

export const fieldsOf = (p: Provider) =>
  Object.entries(PROVIDERS[p]) as [string, FieldDef][];
export const secretFields = (p: Provider) =>
  fieldsOf(p)
    .filter(([, f]) => f.secret)
    .map(([name]) => name);

type S = string | null;
export interface StorageConfig {
  account_id: S;
  access_key_id: S;
  secret_access_key: S;
  bucket: S;
  public_url: S;
  private_bucket: S;
  legacy_bucket: S;
}
export interface SmsConfig {
  enabled: boolean;
  auth_key: S;
  sender_id: S;
  template_id: S;
}
export interface PaymentsConfig {
  gateway: 'razorpay' | 'stripe' | 'none';
  razorpay_key_id: S;
  razorpay_key_secret: S;
  razorpay_webhook_secret: S;
  stripe_secret: S;
  stripe_webhook_secret: S;
}
export interface AiConfig {
  api_key: S;
  model: S;
  max_tokens: number | null;
  daily_token_limit: number | null;
}
export interface VdoCipherConfig {
  api_secret: S;
  marketing_video_id: S;
  public_video_ids: S;
  otp_ttl: number | null;
}
export interface Configs {
  storage: StorageConfig;
  sms: SmsConfig;
  payments: PaymentsConfig;
  ai: AiConfig;
  vdocipher: VdoCipherConfig;
}

/** The provider is usable (what the panel's "configured" badge shows). */
export function isConfigured<P extends Provider>(p: P, cfg: Configs[P]) {
  switch (p) {
    case 'storage': {
      const c = cfg as StorageConfig;
      return !!(
        c.account_id &&
        c.access_key_id &&
        c.secret_access_key &&
        c.bucket &&
        c.public_url &&
        c.private_bucket
      );
    }
    case 'sms': {
      const c = cfg as SmsConfig;
      return c.enabled && !!c.auth_key && !!c.template_id;
    }
    case 'payments': {
      const c = cfg as PaymentsConfig;
      return c.gateway === 'stripe'
        ? !!c.stripe_secret
        : c.gateway === 'razorpay' &&
            !!c.razorpay_key_id &&
            !!c.razorpay_key_secret;
    }
    case 'ai':
      return !!(cfg as AiConfig).api_key;
    case 'vdocipher':
      return !!(cfg as VdoCipherConfig).api_secret;
  }
  return false;
}

/** Defaults for every field: what applies while nothing is saved. */
export function defaultsOf<P extends Provider>(p: P): Configs[P] {
  return Object.fromEntries(
    fieldsOf(p).map(([name, f]) => [name, f.default ?? null]),
  ) as unknown as Configs[P];
}

/** A request value in the field's stored form. */
export function coerce(f: FieldDef, v: unknown): Value {
  if (f.type === 'bool')
    return v === true || v === 1 || v === '1' || v === 'true';
  if (v === undefined || v === null || v === '') return f.default ?? null;
  if (f.type === 'int') return Number(v);
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v.trim() : null;
}

/** Error text for display: secrets masked, one line, bounded. */
export function sanitizeError(e: unknown, secrets: (string | null)[]): string {
  let text = e instanceof Error ? e.message : String(e);
  for (const s of secrets) {
    if (s && s.length >= 3) text = text.split(s).join('***');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || 'Unknown error';
}
