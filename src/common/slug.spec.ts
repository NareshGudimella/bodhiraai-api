import { firstFreeSlug, slugBase } from './slug';

describe('slugBase', () => {
  it('slugs a title like Str::slug', () => {
    expect(slugBase('Fractions & Decimals: Part 1', 'lesson')).toBe(
      'fractions-decimals-part-1',
    );
  });

  it('puts the entity word in front of an all-digit title', () => {
    expect(slugBase('2024', 'lesson')).toBe('lesson-2024');
    expect(slugBase(' 12 34 ', 'quiz')).toBe('12-34'); // not all digits: still a slug
    expect(slugBase('Class 8', 'lesson')).toBe('class-8');
  });

  it('falls back to the entity word for symbol-only titles', () => {
    expect(slugBase('!!! ???', 'chapter')).toBe('chapter');
    expect(slugBase('', 'chapter')).toBe('chapter');
  });

  it('cuts long titles at a word boundary', () => {
    const slug = slugBase('word '.repeat(40), 'lesson');
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.startsWith('word-')).toBe(true);
    expect(slug.endsWith('word')).toBe(true);
    expect(slugBase(`${'a'.repeat(79)} bcd`, 'x')).toBe('a'.repeat(79));
    expect(slugBase('a'.repeat(100), 'x')).toBe('a'.repeat(80));
  });

  it('keeps Unicode letters', () => {
    expect(slugBase('Café Müller', 'lesson')).toBe('cafe-muller');
    expect(slugBase('गणित अध्याय', 'chapter')).not.toBe('chapter');
    expect(slugBase('日本語 レッスン', 'lesson')).toBe('日本語-レッスン');
    expect(slugBase('１２３', 'lesson')).toBe('lesson-123');
  });
});

describe('firstFreeSlug', () => {
  const taking = (used: string[]) => (s: string) =>
    Promise.resolve(used.includes(s));

  it('keeps the plain slug when free', async () => {
    expect(await firstFreeSlug('maths', taking([]))).toBe('maths');
  });

  it('appends -2, -3, … on collisions', async () => {
    expect(await firstFreeSlug('maths', taking(['maths']))).toBe('maths-2');
    expect(
      await firstFreeSlug('maths', taking(['maths', 'maths-2', 'maths-3'])),
    ).toBe('maths-4');
  });
});
