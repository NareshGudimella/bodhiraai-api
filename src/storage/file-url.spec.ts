import { createHmac } from 'node:crypto';
import {
  assertFileUrlConfig,
  decodeKey,
  DEV_FILE_URL_SECRET,
  encodeKey,
  fileUrlSecret,
  fileUrlTtl,
  ForgedFileUrl,
  isForbiddenKey,
  signedFileUrl,
  signFileKey,
  unsignFileUrl,
  verifyFileSignature,
} from './file-url';

const SECRET = 'unit-test-secret-0123456789abcdef0123456789';
const env = {
  NODE_ENV: 'test',
  FILE_URL_SECRET: SECRET,
  FILES_BASE_URL: 'https://site.test/',
  FILE_URL_TTL: '1800',
};
const NOW = 1_800_000_000_000; // ms
const nowS = NOW / 1000;

const parse = (url: string) => {
  const u = new URL(url);
  return {
    path: u.pathname,
    key: decodeKey(u.pathname.replace(/^\/files\//, ''))!,
    exp: u.searchParams.get('exp')!,
    sig: u.searchParams.get('sig')!,
  };
};

describe('signed file links (security: not in legacy)', () => {
  it('signs per the contract: base64url HMAC-SHA256 of "<key>\\n<exp>"', () => {
    const url = signFileKey('cloud/2026/11/01/a.jpg', { now: NOW, env });
    const exp = nowS + 1800;
    const sig = createHmac('sha256', SECRET)
      .update(`cloud/2026/11/01/a.jpg\n${exp}`)
      .digest('base64url');
    expect(url).toBe(
      `https://site.test/files/cloud/2026/11/01/a.jpg?exp=${exp}&sig=${sig}`,
    );
    expect(sig).not.toMatch(/[=+/]/);
  });

  it('verifies a fresh link', () => {
    const { key, exp, sig } = parse(
      signFileKey('lessons/3/x.pdf', { now: NOW, env }),
    );
    expect(verifyFileSignature(key, exp, sig, { now: NOW, env })).toEqual({
      ok: true,
      exp: nowS + 1800,
    });
  });

  it('rejects an expired link, and one more than 24 h ahead', () => {
    const { key, exp, sig } = parse(signFileKey('a/b.png', { now: NOW, env }));
    const later = (nowS + 1801) * 1000;
    expect(verifyFileSignature(key, exp, sig, { now: later, env }).ok).toBe(
      false,
    );
    const far = parse(
      signFileKey('a/b.png', { now: NOW, env, ttl: 86_400 + 60 }),
    );
    expect(
      verifyFileSignature(far.key, far.exp, far.sig, { now: NOW, env }).ok,
    ).toBe(false);
  });

  it('rejects tampering with the key, exp or sig, and another secret', () => {
    const { key, exp, sig } = parse(
      signFileKey('submissions/5/a.pdf', { now: NOW, env }),
    );
    const check = (k: string, e: unknown, s: unknown, e2 = env) =>
      verifyFileSignature(k, e, s, { now: NOW, env: e2 }).ok;
    expect(check(key, exp, sig)).toBe(true);
    expect(check('submissions/6/a.pdf', exp, sig)).toBe(false);
    expect(check(key, String(Number(exp) + 1), sig)).toBe(false);
    expect(
      check(key, exp, `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`),
    ).toBe(false);
    expect(check(key, exp, undefined)).toBe(false);
    expect(check(key, undefined, sig)).toBe(false);
    expect(check(key, [exp], sig)).toBe(false);
    expect(check(key, exp, `${sig}=`)).toBe(false);
    expect(
      check(key, exp, sig, { ...env, FILE_URL_SECRET: `${SECRET}x` }),
    ).toBe(false);
  });

  it.each([
    'invoices/1/INV-1.pdf',
    'Invoices/1/INV-1.pdf',
    '/abs/key.png',
    'a/../invoices/1.pdf',
    'a\\b.png',
    'a//b.png',
    'a/b/',
    '',
    'a/\u0000.png',
  ])('never signs or serves %j', (key) => {
    expect(isForbiddenKey(key)).toBe(true);
    expect(() => signFileKey(key, { env })).toThrow();
    const sig = createHmac('sha256', SECRET)
      .update(`${key}\n${nowS + 60}`)
      .digest('base64url');
    expect(
      verifyFileSignature(key, String(nowS + 60), sig, { now: NOW, env }).ok,
    ).toBe(false);
  });

  it('encodes each path segment and round-trips', () => {
    const key = 'cloud/2026/11/01/mé file#1?.jpg';
    const url = signFileKey(key, { now: NOW, env });
    expect(url).toContain(
      '/files/cloud/2026/11/01/m%C3%A9%20file%231%3F.jpg?exp=',
    );
    const p = parse(url);
    expect(p.key).toBe(key);
    expect(verifyFileSignature(p.key, p.exp, p.sig, { now: NOW, env }).ok).toBe(
      true,
    );
    expect(encodeKey('a/b c')).toBe('a/b%20c');
    expect(decodeKey('a/%E0%A4')).toBeNull();
  });

  it('signs only /files/ values on the way out', () => {
    const prev = { ...process.env };
    Object.assign(process.env, env);
    try {
      expect(signedFileUrl('/files/cloud/a.jpg')).toMatch(
        /^https:\/\/site\.test\/files\/cloud\/a\.jpg\?exp=\d+&sig=[\w-]{43}$/,
      );
      for (const v of [
        null,
        undefined,
        '',
        'https://x.test/a.mp4',
        '/media/a.mp4',
        '/cloud/a.jpg',
      ])
        expect(signedFileUrl(v)).toBe(v);
      // Forbidden keys stay unsigned (unusable), never signed.
      expect(signedFileUrl('/files/invoices/1/a.pdf')).toBe(
        '/files/invoices/1/a.pdf',
      );
    } finally {
      process.env = prev;
    }
  });

  it('turns our signed links back into /files/<key> and rejects forged ones', () => {
    const url = signFileKey('lessons/3/a b.pdf', { now: NOW, env });
    // Expired links of ours are still accepted on write (a form left open).
    expect(unsignFileUrl(url, env)).toBe('/files/lessons/3/a b.pdf');
    expect(unsignFileUrl('https://cdn.test/a.mp4', env)).toBe(
      'https://cdn.test/a.mp4',
    );
    expect(unsignFileUrl(null, env)).toBeNull();
    const forged = url.replace('lessons/3', 'lessons/4');
    expect(() => unsignFileUrl(forged, env)).toThrow(ForgedFileUrl);
    expect(() => unsignFileUrl('https://site.test/files/x/y.pdf', env)).toThrow(
      ForgedFileUrl,
    );
    expect(() => unsignFileUrl('/files/submissions/1/a.pdf', env)).toThrow(
      ForgedFileUrl,
    );
    expect(() =>
      unsignFileUrl(
        'https://site.test/files/a/../invoices/1/x.pdf?exp=1&sig=x',
        env,
      ),
    ).toThrow(ForgedFileUrl);
  });

  it('fails closed in production without a secret; dev default elsewhere', () => {
    expect(fileUrlSecret({ NODE_ENV: 'development' })).toBe(
      DEV_FILE_URL_SECRET,
    );
    expect(() => fileUrlSecret({ NODE_ENV: 'production' })).toThrow(
      /FILE_URL_SECRET/,
    );
    expect(() =>
      fileUrlSecret({ NODE_ENV: 'production', FILE_URL_SECRET: 'short' }),
    ).toThrow();
    expect(() =>
      signFileKey('a/b.png', {
        env: { NODE_ENV: 'production', FILES_BASE_URL: 'https://x' },
      }),
    ).toThrow(/FILE_URL_SECRET/);
    expect(() => assertFileUrlConfig({ NODE_ENV: 'production' })).toThrow();
    expect(() =>
      assertFileUrlConfig({ NODE_ENV: 'production', FILE_URL_SECRET: SECRET }),
    ).toThrow(/FILES_BASE_URL/);
    expect(() =>
      assertFileUrlConfig({
        NODE_ENV: 'production',
        FILE_URL_SECRET: SECRET,
        FILES_BASE_URL: 'https://site.test',
      }),
    ).not.toThrow();
    expect(() =>
      assertFileUrlConfig({ NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('reads FILE_URL_TTL with a default and bounds', () => {
    expect(fileUrlTtl({})).toBe(1800);
    expect(fileUrlTtl({ FILE_URL_TTL: 'abc' })).toBe(1800);
    expect(fileUrlTtl({ FILE_URL_TTL: '600' })).toBe(600);
    expect(fileUrlTtl({ FILE_URL_TTL: '5' })).toBe(60);
    expect(fileUrlTtl({ FILE_URL_TTL: '999999' })).toBe(86_400);
  });
});
