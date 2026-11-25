/** The mail configuration in effect: the `mail_settings` row, else the defaults. */
export interface MailConfig {
  source: 'database' | 'none';
  /** `array` (tests) is never stored. */
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

/**
 * not in legacy (2026-11-25): with nothing saved in the admin panel, Laravel's
 * defaults apply (the `log` mailer). The MAIL_* environment is no longer read;
 * `npm run settings:import-env` copies it into the panel once.
 */
export function defaultMailConfig(): MailConfig {
  return {
    source: 'none',
    mailer: 'log',
    host: null,
    port: 587,
    encryption: 'none',
    username: null,
    password: null,
    fromAddress: 'hello@example.com',
    fromName: 'Bodhira',
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
