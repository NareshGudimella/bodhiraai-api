import { capHistory } from './ai.service';

const turn = (role: string, n: number) => ({ role, content: 'x'.repeat(n) });

describe('capHistory', () => {
  const newestFirst = [
    turn('assistant', 300),
    turn('user', 300),
    turn('assistant', 300),
    turn('user', 300),
  ];

  it('keeps the newest turns that fit, oldest first', () => {
    expect(capHistory(newestFirst, 700).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('never starts with an assistant turn', () => {
    expect(capHistory(newestFirst, 1000).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('drops everything when the newest turn alone is too big', () => {
    expect(capHistory([turn('assistant', 9000)], 8000)).toEqual([]);
  });
});
