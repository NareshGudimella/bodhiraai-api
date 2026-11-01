import { randomInt } from 'node:crypto';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Str::random(n). */
export function strRandom(n: number): string {
  return Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join(
    '',
  );
}

/**
 * Str::slug($title, $separator), step by step as Laravel does it: ASCII-fold,
 * turn the other dash style (`_` for '-', '-' otherwise) into the separator,
 * '@' into 'at', drop anything that isn't a letter, number, whitespace or
 * separator, then collapse runs. Laravel's fold (voku/portable-ascii) also
 * transliterates non-Latin scripts; this one only strips accents, so e.g.
 * Devanagari letters are kept as-is.
 */
export function strSlug(title: string, separator = '-'): string {
  const sep = separator.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  const flip = separator === '-' ? '_' : '-';
  let out = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(new RegExp(`[${flip === '-' ? '\\-' : flip}]+`, 'g'), separator)
    .replace(/@/g, `${separator}at${separator}`)
    .toLowerCase()
    .replace(new RegExp(`[^${sep}\\p{L}\\p{N}\\s]+`, 'gu'), '')
    .replace(new RegExp(`[${sep}\\s]+`, 'gu'), separator);
  while (out.startsWith(separator)) out = out.slice(separator.length);
  while (out.endsWith(separator)) out = out.slice(0, -separator.length);
  return out;
}

/** Unicode Case_Ignorable: marks, format chars, modifiers, and word-internal punctuation. */
const CASE_IGNORABLE =
  /[\p{Mn}\p{Me}\p{Cf}\p{Lm}\p{Sk}'.:\u00B7\u2018\u2019\u2024\u2027\uFE13\uFE52\uFE55\uFF07\uFF0E\uFF1A]/u;

/**
 * Str::title(): mb_convert_case(MB_CASE_TITLE). A letter starts a word unless
 * the last non-case-ignorable character was a letter ("3d" → "3D", "it's" → "It's").
 */
export function strTitle(value: string): string {
  let inWord = false;
  let out = '';
  for (const c of value) {
    if (/\p{L}/u.test(c)) {
      out += inWord ? c.toLowerCase() : c.toUpperCase();
      inWord = true;
    } else {
      out += c;
      if (!CASE_IGNORABLE.test(c)) inWord = false;
    }
  }
  return out;
}

/**
 * Str::headline(): "my_photo-final" → "My Photo Final", "EmailSent" →
 * "Email Sent". Several words are title-cased each; a single word is first
 * split before its capitals (Str::ucsplit).
 */
export function strHeadline(value: string): string {
  const words = value.split(/\s+/u);
  const parts =
    words.length > 1
      ? words.map(strTitle)
      : words
          .join('_')
          .split(/(?=\p{Lu})/u)
          .filter(Boolean)
          .map(strTitle);
  return parts
    .join('_')
    .replace(/[-_ ]/g, '_')
    .split('_')
    .filter(Boolean)
    .join(' ');
}
