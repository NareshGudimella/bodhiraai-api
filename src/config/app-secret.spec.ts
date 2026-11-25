import { appSecretBytes, assertAppSecret, derivedKey } from './app-secret';

const APP_SECRET = Buffer.alloc(32, 9).toString('base64');

describe('APP_SECRET (not in legacy)', () => {
  it('derives a different, stable 32-byte key per purpose', () => {
    const env = { APP_SECRET };
    const keys = (['settings', 'file-urls', 'proxy'] as const).map((p) =>
      derivedKey(p, env),
    );
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(derivedKey('proxy', env)).toBe(derivedKey('proxy', { APP_SECRET }));
    expect(keys).not.toContain(
      Buffer.from(APP_SECRET, 'base64').toString('hex'),
    );
  });

  it('accepts hex or base64, rejects short keys', () => {
    expect(appSecretBytes({ APP_SECRET: 'ab'.repeat(32) })).toHaveLength(32);
    expect(appSecretBytes({ APP_SECRET })).toHaveLength(32);
    expect(() => appSecretBytes({ APP_SECRET: 'short' })).toThrow(/32 bytes/);
    expect(appSecretBytes({})).toBeNull();
  });

  it('is required in production only', () => {
    expect(() => assertAppSecret({ NODE_ENV: 'production' })).toThrow(
      /APP_SECRET/,
    );
    expect(() => derivedKey('settings', { NODE_ENV: 'production' })).toThrow(
      /APP_SECRET/,
    );
    expect(() =>
      assertAppSecret({ NODE_ENV: 'production', APP_SECRET }),
    ).not.toThrow();
    expect(derivedKey('settings', { NODE_ENV: 'development' })).toBeNull();
  });
});
