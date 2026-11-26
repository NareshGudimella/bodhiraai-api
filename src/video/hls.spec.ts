import { signHlsToken, verifyHlsToken } from './hls-token';
import {
  istStamp,
  newSessionId,
  overPlaybackLimit,
  segmentsUntil,
} from './video-session';
import { chooseRenditions } from './hls-transcode';

describe('HLS token (strict playback protection)', () => {
  const S = 'ab'.repeat(16);
  const now = 1_700_000_000_000;
  const exp = 1_700_000_000 + 3600;
  const token = signHlsToken(S, 5n, 9n, exp);

  it('verifies for its lesson only, until it expires', () => {
    expect(verifyHlsToken(5n, token, { now })).toEqual({
      session: S,
      user: 9n,
      exp,
    });
    expect(verifyHlsToken(6n, token, { now })).toBeNull();
    expect(verifyHlsToken(5n, token, { now: (exp + 1) * 1000 })).toBeNull();
  });

  it('covers the session, user and expiry', () => {
    const [, u, e, m] = token.split('.');
    const other = 'cd'.repeat(16);
    expect(verifyHlsToken(5n, `${other}.${u}.${e}.${m}`, { now })).toBeNull();
    expect(verifyHlsToken(5n, `${S}.10.${e}.${m}`, { now })).toBeNull();
    expect(verifyHlsToken(5n, `${S}.${u}.${exp + 1}.${m}`, { now })).toBeNull();
    expect(
      verifyHlsToken(5n, `${S}.${u}.${e}.${m.slice(0, -1)}A`, { now }),
    ).toBeNull();
    expect(verifyHlsToken(5n, undefined)).toBeNull();
    expect(verifyHlsToken(5n, 'garbage')).toBeNull();
  });
});

describe('video session maths', () => {
  const t0 = new Date('2026-11-27T20:30:00Z'); // 02:00 IST next day

  it('session ids are 128 random bits as hex', () => {
    expect(newSessionId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it('formats in IST whatever the process time zone', () => {
    expect(istStamp(t0)).toBe('28 Nov 2026 02:00 IST');
    expect(istStamp(new Date('2026-11-27T18:30:00Z'))).toBe(
      '28 Nov 2026 00:00 IST',
    );
  });

  it('segments_until: duration + 30 min, 6 h when unknown, capped at 6 h', () => {
    const h = 3600_000;
    expect(segmentsUntil(t0, 600).getTime() - t0.getTime()).toBe(40 * 60_000);
    expect(segmentsUntil(t0, null).getTime() - t0.getTime()).toBe(6 * h);
    expect(segmentsUntil(t0, 0).getTime() - t0.getTime()).toBe(6 * h);
    expect(segmentsUntil(t0, 10 * 3600).getTime() - t0.getTime()).toBe(6 * h);
  });

  it('limits: 20 an hour, 100 a day', () => {
    expect(overPlaybackLimit(19, 99)).toBe(false);
    expect(overPlaybackLimit(20, 20)).toBe(true);
    expect(overPlaybackLimit(5, 100)).toBe(true);
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
