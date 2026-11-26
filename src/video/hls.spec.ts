import { signHlsToken, verifyHlsToken } from './hls-token';
import { chooseRenditions } from './hls-transcode';

describe('HLS token', () => {
  it('verifies for its lesson only, until it expires', () => {
    const now = 1_700_000_000_000;
    const { token, exp } = signHlsToken(5n, 9n, { now });
    expect(exp).toBe(1_700_000_000 + 6 * 3600);
    expect(verifyHlsToken(5n, token, { now })).toBe(exp);
    expect(verifyHlsToken(6n, token, { now })).toBeNull();
    expect(
      verifyHlsToken(5n, token, { now: now + 6 * 3600 * 1000 + 1000 }),
    ).toBeNull();
    const [u, e, m] = token.split('.');
    expect(verifyHlsToken(5n, `10.${e}.${m}`, { now })).toBeNull(); // another user
    expect(verifyHlsToken(5n, `${u}.${exp + 1}.${m}`, { now })).toBeNull();
    expect(verifyHlsToken(5n, undefined)).toBeNull();
    expect(verifyHlsToken(5n, 'garbage')).toBeNull();
  });
});

describe('chooseRenditions', () => {
  const names = (w: number, h: number) =>
    chooseRenditions(w, h).map((r) => `${r.name}:${r.width}x${r.height}`);
  it('never upscales', () => {
    expect(names(1920, 1080)).toEqual(['360p:640x360', '720p:1280x720']);
    expect(names(1280, 720)).toEqual(['360p:640x360', '720p:1280x720']);
    expect(names(854, 480)).toEqual(['360p:640x360']);
    expect(names(320, 240)).toEqual(['360p:320x240']); // smaller: one rendition at its own size
  });
});
