import {
  attendanceSummary,
  classifyAiSessions,
  gIA,
  mY,
  mjY,
  reportContentDisposition,
  strSlug,
} from './student-report';

describe('student report helpers', () => {
  it('slugs names like Str::slug', () => {
    expect(strSlug('Aarav Sharma')).toBe('aarav-sharma');
    expect(strSlug("  Zoë  O'Neil_Jr. ")).toBe('zoe-oneil-jr');
    expect(strSlug('me@x.com')).toBe('me-at-xcom');
    expect(strSlug('తెలుగు')).toBe('');
  });

  it('formats dates like Carbon', () => {
    const d = new Date('2026-10-30T00:05:00Z');
    expect(mjY(d)).toBe('Oct 30, 2026');
    expect(mY(d)).toBe('Oct 2026');
    expect(gIA(d)).toBe('12:05 AM');
    expect(gIA(new Date('2026-01-02T13:00:00Z'))).toBe('1:00 PM');
  });

  it('counts attendance and rounds the percent half up', () => {
    expect(attendanceSummary([])).toEqual({
      total: 0,
      present: 0,
      late: 0,
      excused: 0,
      absent: 0,
      percent: 0,
    });
    const a = attendanceSummary([
      'present',
      'late',
      'absent',
      'excused',
      'absent',
      'absent',
      'present',
      'present',
    ]);
    expect(a).toMatchObject({
      total: 8,
      present: 3,
      late: 1,
      excused: 1,
      absent: 3,
      percent: 63,
    });
  });

  it('classifies AI conversations', () => {
    const r = classifyAiSessions(
      ['Help with MATHS', 'Watching: Photosynthesis', 'random chat', null],
      ['Maths', null, ''],
    );
    expect(r).toEqual({
      subject_count: 2,
      other_count: 2,
      subject_pct: 50,
      other_pct: 50,
    });
    expect(classifyAiSessions([], []).subject_pct).toBe(0);
  });
});

describe('reportContentDisposition', () => {
  it('keeps the legacy name for Latin names', () => {
    const r = reportContentDisposition({ id: 7, name: 'Aarav Sharma' });
    expect(r.filename).toBe('bodhira-report-aarav-sharma.pdf');
    expect(r.header).toBe(
      'attachment; filename="bodhira-report-aarav-sharma.pdf"',
    );
  });

  it('falls back to the id and adds filename* for non-Latin names', () => {
    const r = reportContentDisposition({ id: 42, name: 'తెలుగు' });
    expect(r.filename).toBe('progress-report-42.pdf');
    expect(r.header).toContain('filename="progress-report-42.pdf"');
    expect(r.header).toContain(
      `filename*=UTF-8''bodhira-report-${encodeURIComponent('తెలుగు')}.pdf`,
    );
    expect(r.header).not.toMatch(/filename="[^"]*[^\x20-\x7e][^"]*"/);
  });

  it('adds filename* for mixed names, and strips unsafe characters', () => {
    const r = reportContentDisposition({ id: 1, name: 'Zoë "O/Neil"*' });
    expect(r.filename).toBe('bodhira-report-zoe-oneil.pdf');
    expect(r.header).toContain(
      "filename*=UTF-8''bodhira-report-Zo%C3%AB%20O%20Neil.pdf",
    );
  });

  it('never throws on astral characters at the length cap', () => {
    const name = '😀'.repeat(100);
    expect(() => reportContentDisposition({ id: 1, name })).not.toThrow();
  });
});
