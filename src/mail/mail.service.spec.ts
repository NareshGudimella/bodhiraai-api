import { productionMailProblem, envMailConfig } from './mail-config';
import { decryptSecret, encryptSecret, mailKey } from './mail-crypto';
import { MailService, sanitizeMailError } from './mail.service';
import type { MailSettingsService } from './mail-settings.service';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('mail-crypto', () => {
  const env = { NODE_ENV: 'test', MAIL_SETTINGS_KEY: KEY };

  it('round-trips and never stores plaintext', () => {
    const stored = encryptSecret('s3cret-pässword', env);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain('s3cret');
    expect(decryptSecret(stored, env)).toBe('s3cret-pässword');
    // random IV: same input, different ciphertext
    expect(encryptSecret('s3cret-pässword', env)).not.toBe(stored);
  });

  it('accepts a 64-hex key and rejects tampering or the wrong key', () => {
    const hex = { NODE_ENV: 'test', MAIL_SETTINGS_KEY: 'ab'.repeat(32) };
    expect(decryptSecret(encryptSecret('x', hex), hex)).toBe('x');
    const stored = encryptSecret('x', env);
    expect(() => decryptSecret(stored, hex)).toThrow();
    expect(() => decryptSecret(stored.slice(0, -2) + 'AA', env)).toThrow();
  });

  it('requires a 32-byte key; only development may omit it', () => {
    expect(() =>
      mailKey({ NODE_ENV: 'production', MAIL_SETTINGS_KEY: 'short' }),
    ).toThrow(/32 bytes/);
    expect(() => mailKey({ NODE_ENV: 'production' })).toThrow(/not set/);
    expect(mailKey({ NODE_ENV: 'development' })).toHaveLength(32);
  });
});

describe('envMailConfig (fallback when no row exists)', () => {
  it('reads the MAIL_* variables like config/mail.php', () => {
    expect(
      envMailConfig({
        MAIL_MAILER: 'smtp',
        MAIL_HOST: 'smtp.example.com',
        MAIL_PORT: '465',
        MAIL_USERNAME: 'u',
        MAIL_PASSWORD: 'p',
        MAIL_FROM_ADDRESS: 'a@example.com',
      }),
    ).toMatchObject({
      source: 'env',
      mailer: 'smtp',
      host: 'smtp.example.com',
      port: 465,
      encryption: 'ssl',
      username: 'u',
      password: 'p',
      fromAddress: 'a@example.com',
      fromName: 'Bodhira',
    });
    expect(envMailConfig({})).toMatchObject({
      mailer: 'log',
      port: 587,
      encryption: 'none',
    });
    expect(envMailConfig({ MAIL_SCHEME: 'smtps' }).encryption).toBe('ssl');
  });
});

describe('productionMailProblem', () => {
  const prod = { NODE_ENV: 'production' };
  it('only a complete smtp config is usable in production', () => {
    for (const MAIL_MAILER of ['log', 'array', undefined]) {
      expect(
        productionMailProblem(envMailConfig({ MAIL_MAILER }), prod),
      ).toMatch(/needs "smtp"/);
    }
    expect(
      productionMailProblem(envMailConfig({ MAIL_MAILER: 'smtp' }), prod),
    ).toMatch(/no SMTP host/);
    expect(
      productionMailProblem(
        envMailConfig({ MAIL_MAILER: 'smtp', MAIL_HOST: 'h' }),
        prod,
      ),
    ).toBeNull();
  });
  it('allows anything outside production', () => {
    expect(
      productionMailProblem(envMailConfig({}), { NODE_ENV: 'test' }),
    ).toBeNull();
  });
});

describe('MailService', () => {
  const settings = (mailer: string, host: string | null = null) =>
    ({
      effective: () => Promise.resolve({ ...envMailConfig({}), mailer, host }),
    }) as unknown as MailSettingsService;
  const msg = {
    to: { address: 'a@example.com' },
    subject: 's',
    text: 'RESET LINK https://x/reset/abc',
  };

  it('in production refuses log without writing the body anywhere', async () => {
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const svc = new MailService(settings('log'));
      const logged: string[] = [];
      for (const level of ['log', 'error', 'warn'] as const) {
        jest
          .spyOn(svc['logger'], level)
          .mockImplementation((m: unknown) => void logged.push(String(m)));
      }
      await expect(svc.send(msg)).rejects.toThrow(/not configured/);
      expect(logged.join('\n')).toMatch(/not configured/);
      expect(logged.join('\n')).not.toContain('RESET LINK');
      expect(svc.sent).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = old;
    }
  });

  it('keeps the array mailer for tests and logs with the log mailer outside production', async () => {
    const arr = new MailService(settings('array'));
    await arr.send(msg);
    expect(arr.sent).toHaveLength(1);
    const log = new MailService(settings('log'));
    const spy = jest.spyOn(log['logger'], 'log').mockImplementation();
    await log.send(msg);
    expect(spy).toHaveBeenCalled();
  });

  it('sendTest reports a sanitised error', async () => {
    const svc = new MailService(settings('nope'));
    jest.spyOn(svc['logger'], 'warn').mockImplementation();
    const r = await svc.sendTest('a@example.com');
    expect(r).toEqual({ sent: false, error: 'Mailer [nope] is not defined.' });
  });
});

describe('sanitizeMailError', () => {
  it('removes credentials and bounds the length', () => {
    const cfg = {
      ...envMailConfig({}),
      username: 'mailuser',
      password: 'hunter2hunter2',
    };
    const out = sanitizeMailError(
      new Error(`Invalid login mailuser / hunter2hunter2\n${'x'.repeat(400)}`),
      cfg,
    );
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('mailuser');
    expect(out.length).toBeLessThanOrEqual(301);
  });
});
