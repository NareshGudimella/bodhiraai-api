/** The mail configuration in effect: the `mail_settings` row, else the MAIL_* environment. */
export interface MailConfig {
  source: 'database' | 'env';
  /** `array` (tests) exists only for the env source. */
  mailer: string;
  host: string | null;
  port: number;
  /** `tls` = STARTTLS, `ssl` = implicit TLS. */
  encryption: 'tls' | 'ssl' | 'none';
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string;
}

/** Laravel's config/mail.php from MAIL_* (port 465 or MAIL_SCHEME=smtps imply implicit TLS). */
export function envMailConfig(
  env: NodeJS.ProcessEnv = process.env,
): MailConfig {
  const port = Number(env.MAIL_PORT ?? 587);
  return {
    source: 'env',
    mailer: env.MAIL_MAILER || 'log',
    host: env.MAIL_HOST || null,
    port,
    encryption: env.MAIL_SCHEME === 'smtps' || port === 465 ? 'ssl' : 'none',
    username: env.MAIL_USERNAME || null,
    password: env.MAIL_PASSWORD ?? null,
    fromAddress: env.MAIL_FROM_ADDRESS ?? 'hello@example.com',
    fromName: env.MAIL_FROM_NAME ?? 'Bodhira',
  };
}

/**
 * security: not in legacy. In production only a complete `smtp` configuration is
 * usable: the `log` mailer would write password-reset links (account takeover
 * material) to the log and `array` keeps them in memory. Returns the reason
 * when the configuration can't be used, else null.
 */
export function productionMailProblem(
  cfg: MailConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (cfg.mailer !== 'smtp') {
    return `the mailer is "${cfg.mailer}", but production needs "smtp"`;
  }
  if (!cfg.host) return 'no SMTP host is set';
  return null;
}
