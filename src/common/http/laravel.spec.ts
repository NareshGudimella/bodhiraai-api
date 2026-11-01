import {
  diffForHumans,
  eloquentDate,
  eloquentRow,
  iso8601,
  phpJsonEncode,
  rawDateTime,
} from './laravel';

describe('Laravel serialisation helpers', () => {
  const d = new Date('2026-06-02T12:23:18.000Z');

  it('formats dates like Carbon/Eloquent', () => {
    expect(iso8601(d)).toBe('2026-06-02T12:23:18+00:00');
    expect(eloquentDate(d)).toBe('2026-06-02T12:23:18.000000Z');
    expect(rawDateTime(d)).toBe('2026-06-02 12:23:18');
    expect(iso8601(null)).toBeNull();
  });

  it('encodes JSON like PHP json_encode', () => {
    // Expected values produced by PHP 8: json_encode(["a/b","é","😀","\x7f"])
    expect(phpJsonEncode(['a/b', 'é', '😀', '\x7f'])).toBe(
      '["a\\/b","\\u00e9","\\ud83d\\ude00","\x7f"]',
    );
    expect(phpJsonEncode({ desc: 'Passed — great' })).toBe(
      '{"desc":"Passed \\u2014 great"}',
    );
  });

  it.each([
    [30, 'seconds', '30 seconds ago'],
    [90, 'seconds', '1 minute ago'],
    [3 * 3600, 'seconds', '3 hours ago'],
    [86400, 'seconds', '1 day ago'],
    [15 * 86400, 'seconds', '2 weeks ago'],
  ])('diffForHumans %s %s → %s', (amount, _unit, expected) => {
    const now = new Date('2026-10-29T08:00:00Z');
    expect(diffForHumans(new Date(now.getTime() - amount * 1000), now)).toBe(
      expected,
    );
  });

  it('diffForHumans uses calendar months and years', () => {
    const now = new Date('2026-10-29T08:00:00Z');
    expect(diffForHumans(new Date('2026-06-14T10:00:00Z'), now)).toBe(
      '4 months ago',
    );
    expect(diffForHumans(new Date('2024-09-01T00:00:00Z'), now)).toBe(
      '2 years ago',
    );
    expect(diffForHumans(new Date('2026-11-05T08:00:00Z'), now)).toBe(
      '1 week from now',
    );
  });

  it('eloquentRow applies $hidden, $casts and raw PDO values', () => {
    const row = eloquentRow(
      {
        id: 1n,
        password: 'secret',
        is_free: true,
        settings: '{"a":1}',
        dob: new Date('2011-04-15T00:00:00Z'),
        last_seen: d,
        created_at: d,
      },
      { hidden: ['password'], casts: { settings: 'array', dob: 'date' } },
    );
    expect(row).toEqual({
      id: 1n,
      is_free: 1,
      settings: { a: 1 },
      dob: '2011-04-15T00:00:00.000000Z',
      last_seen: '2026-06-02 12:23:18',
      created_at: '2026-06-02T12:23:18.000000Z',
    });
  });
});
