import { strLimit } from '../common/http/php-strings';
import { liveStatus } from '../live-class/live-class.service';
import { parseLaravelDate } from '../live-class/live-class.validation';
import { approxTokens, stubResponse } from './ai-tutor';

describe('Str::limit port (expected values produced by PHP 8.5)', () => {
  it.each([
    ['Short title', 60, 'Short title'],
    [
      '数学の問題を教えてください。二次方程式の解の公式について詳しく説明してほしいです',
      60,
      '数学の問題を教えてください。二次方程式の解の公式について詳し…',
    ],
    [
      'Can you explain the difference between mitosis and meiosis in detail, with examples?',
      60,
      'Can you explain the difference between mitosis and meiosis i…',
    ],
    ['😀😀😀😀😀', 5, '😀😀…'],
    ['abc def     ghi', 8, 'abc def…'],
    ['नमस्ते दुनिया यह एक लंबा प्रश्न है', 10, 'नमस्ते दुन…'],
  ])('%s (%i)', (value, limit, expected) => {
    expect(strLimit(value, limit, '…')).toBe(expected);
  });
});

describe('AI tutor helpers', () => {
  it('counts tokens per code point, like mb_strlen', () => {
    expect(approxTokens('a')).toBe(1);
    expect(approxTokens('😀😀😀😀😀')).toBe(2);
    expect(approxTokens('x'.repeat(9))).toBe(3);
  });

  it('stub: greeting, arithmetic (PHP number formatting), topics, generic', () => {
    expect(stubResponse('Hey!')).toMatch(/^Hi there!/);
    expect(stubResponse('what is 12 x 3')).toContain('**12 x 3 = 36**');
    expect(stubResponse('10/4')).toContain('**10 / 4 = 2.5**');
    expect(stubResponse('1/3')).toContain('= 0.33333333333333**');
    expect(stubResponse('5/0')).toMatch(/^Good question/);
    expect(stubResponse('Explain PHOTOSYNTHESIS')).toMatch(
      /^\*\*Photosynthesis\*\*/,
    );
    expect(stubResponse('  why is the sky blue  ')).toContain(
      '**"why is the sky blue"**',
    );
  });
});

describe('live classes', () => {
  it('parses dates like Carbon and stores wall-clock time like Eloquent', () => {
    const p = parseLaravelDate('2026-11-01T10:00:00+05:30')!;
    expect(p.instant.toISOString()).toBe('2026-11-01T04:30:00.000Z');
    expect(p.stored.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(parseLaravelDate('2026-11-01 10:00')!.stored.toISOString()).toBe(
      '2026-11-01T10:00:00.000Z',
    );
    expect(parseLaravelDate('2026-02-30 10:00')).toBeNull();
    expect(parseLaravelDate('tomorrow')).toBeNull();
  });

  it('derives live_status from the schedule', () => {
    const base = {
      status: 'scheduled',
      scheduled_at: new Date('2026-11-01T10:00:00Z'),
      duration_min: 45,
    } as Parameters<typeof liveStatus>[0];
    const at = (iso: string) => liveStatus(base, Date.parse(iso));
    expect(at('2026-11-01T09:59:59Z')).toBe('scheduled');
    expect(at('2026-11-01T10:00:00Z')).toBe('live');
    expect(at('2026-11-01T10:45:00Z')).toBe('live');
    expect(at('2026-11-01T10:45:01Z')).toBe('ended');
    expect(liveStatus({ ...base, status: 'cancelled' })).toBe('cancelled');
  });
});
