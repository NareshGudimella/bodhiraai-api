import { isSafeNextPath } from './web-handoff';

describe('isSafeNextPath', () => {
  it('accepts relative paths', () => {
    for (const p of ['/', '/checkout/12', '/billing?x=1#top', '/a//b']) {
      expect(isSafeNextPath(p)).toBe(true);
    }
  });

  it('rejects anything that can leave the site', () => {
    for (const p of [
      '',
      'checkout',
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/a\nb',
      '/' + 'a'.repeat(2000),
      null,
      undefined,
      42,
    ]) {
      expect(isSafeNextPath(p)).toBe(false);
    }
  });
});
