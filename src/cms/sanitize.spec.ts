import { sanitizeCms, sanitizeMap } from './sanitize';

describe('CMS HTML sanitiser (security: not in legacy)', () => {
  it('keeps normal rich text', () => {
    const html =
      '<h2 class="x">T</h2><p>a <strong>b</strong> <em>c</em> <u>d</u><br></p><ul><li>i</li></ul>' +
      '<a href="https://e.com" target="_blank">l</a><a href="mailto:a@b.c">m</a>' +
      '<img src="https://e.com/a.png" alt="x" width="10" height="5">' +
      '<table><tr><td>1</td></tr></table><blockquote>q</blockquote><pre><code>c</code></pre><hr>' +
      '<div class="d"><span class="s">s</span></div>';
    const out = sanitizeCms(html);
    for (const part of [
      '<h2 class="x">',
      '<strong>',
      'href="https://e.com"',
      'rel="noopener noreferrer"',
      'href="mailto:a@b.c"',
      'src="https://e.com/a.png"',
      'width="10"',
      '<td>1</td>',
      '<blockquote>',
      '<pre><code>',
      '<div class="d"><span class="s">',
    ])
      expect(out).toContain(part);
  });

  it('strips scripts, handlers, javascript/data URLs, style, forms and embeds', () => {
    const out = sanitizeCms(
      '<script>alert(1)</script><p onclick="x()" style="background:url(javascript:1)">a</p>' +
        '<a href="javascript:alert(1)">j</a><a href=" JaVaScRiPt:1">j2</a>' +
        '<img src="data:image/png;base64,AAAA" onerror="x()"><img src="x" onerror="x()">' +
        '<object data="x"></object><embed src="x"><form action="x"><input></form><iframe src="https://www.google.com/maps/embed?x"></iframe>',
    );
    expect(out).not.toMatch(
      /script|alert|onclick|onerror|style|javascript|data:|<object|<embed|<form|<input|<iframe/i,
    );
    expect(out).toContain('<p>a</p>');
  });

  it('is idempotent', () => {
    const once = sanitizeCms(
      '<p onclick="x">a</p><a href="https://e.com" target="_blank">l</a>',
    );
    expect(sanitizeCms(once)).toBe(once);
  });

  it('allows an iframe only in the map, and only from Google Maps', () => {
    const google =
      '<iframe src="https://www.google.com/maps/embed?pb=1" width="600" height="450" loading="lazy" onload="x()" style="x"></iframe>';
    expect(sanitizeCms(google)).not.toContain('iframe');
    const ok = sanitizeMap(google);
    expect(ok).toContain('src="https://www.google.com/maps/embed?pb=1"');
    expect(ok).not.toMatch(/onload|style/);
    for (const src of [
      'https://evil.com/maps/embed',
      'https://www.google.com.evil.com/maps/embed',
      'https://www.google.com/other',
      'javascript:alert(1)',
      'data:text/html,x',
    ])
      expect(sanitizeMap(`<iframe src="${src}"></iframe>`)).not.toContain(
        'iframe',
      );
    expect(sanitizeMap('<script>x</script><p>a</p>')).toBe('<p>a</p>');
  });
});
