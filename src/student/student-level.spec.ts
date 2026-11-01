import { XP_PER_LEVEL, levelInfo } from './student.service';

describe('levelInfo', () => {
  it('uses 70 XP per level, like the legacy dashboard', () => {
    expect(XP_PER_LEVEL).toBe(70);
    expect(levelInfo(730)).toEqual({
      level: 10,
      next_level_xp: 770,
      xp_to_next: 40,
      level_percent: 95,
    });
  });

  it('starts at level 0', () => {
    expect(levelInfo(0)).toMatchObject({
      level: 0,
      next_level_xp: 70,
      xp_to_next: 70,
    });
  });
});
