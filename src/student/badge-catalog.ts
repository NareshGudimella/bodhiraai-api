/** Port of App\Support\BadgeCatalog. Keep keys, copy and tiers identical. */

export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum';

const BADGES: Record<
  string,
  [title: string, icon: string, tier: Tier, xp: number, desc: string]
> = {
  // Quiz performance
  perfect_score: [
    'Perfect Score',
    '💯',
    'platinum',
    120,
    'A flawless 100% — not a single mistake.',
  ],
  quiz_conqueror: [
    'Quiz Conqueror',
    '🔥',
    'gold',
    70,
    'Crushed the quiz with a top score.',
  ],
  sharp_mind: [
    'Sharp Mind',
    '🧠',
    'silver',
    45,
    'Scored 80% or higher. Crisp thinking!',
  ],
  quiz_winner: [
    'Quiz Winner',
    '🎉',
    'bronze',
    30,
    'Passed the quiz — momentum building!',
  ],
  fast_finisher: ['Fast Finisher', '🚀', 'gold', 55, 'Aced it in record time.'],
  flawless_combo: [
    'Flawless Victory',
    '👑',
    'platinum',
    150,
    'Perfect score, lightning fast. Elite.',
  ],
  // Subject mastery (mapped by subject name)
  number_ninja: [
    'Number Ninja',
    '🧮',
    'gold',
    55,
    'Mastered a Mathematics challenge.',
  ],
  logic_explorer: [
    'Logic Explorer',
    '🧪',
    'gold',
    55,
    'Conquered a Science quiz.',
  ],
  word_wizard: [
    'Word Wizard',
    '📖',
    'gold',
    55,
    'Top marks in language & literature.',
  ],
  concept_master: [
    'Concept Master',
    '🎓',
    'gold',
    55,
    'Deep mastery of the subject.',
  ],
  // Milestones
  first_steps: [
    'First Steps',
    '🌱',
    'bronze',
    25,
    'Completed your very first quiz.',
  ],
};

const TIERS: Record<Tier, [label: string, stops: string[], glow: string]> = {
  bronze: ['Bronze', ['#F6D9B8', '#CD7F32', '#8C5A24'], 'rgba(205,127,50,.55)'],
  silver: [
    'Silver',
    ['#F4F7FA', '#AEB8C2', '#7D8893'],
    'rgba(174,184,194,.55)',
  ],
  gold: ['Gold', ['#FFF1C9', '#F5C84B', '#C9982E'], 'rgba(245,200,75,.6)'],
  platinum: [
    'Platinum',
    ['#EAFBFF', '#B9F2FF', '#6DD5FA'],
    'rgba(109,213,250,.6)',
  ],
};

export interface Badge {
  key: string;
  title: string;
  icon: string;
  tier: Tier;
  xp: number;
  desc: string;
  tierMeta: { label: string; stops: string[]; glow: string };
}

export function tierMeta(tier: string) {
  const [label, stops, glow] = TIERS[tier as Tier] ?? TIERS.bronze;
  return { label, stops, glow };
}

export function getBadge(key: string): Badge | null {
  const b = BADGES[key];
  if (!b) return null;
  const [title, icon, tier, xp, desc] = b;
  return { key, title, icon, tier, xp, desc, tierMeta: tierMeta(tier) };
}

/** platinum > gold > silver > bronze. */
export function tierRank(tier: string): number {
  return { bronze: 1, silver: 2, gold: 3, platinum: 4 }[tier] ?? 0;
}

/**
 * BadgeCatalog::collection(): full catalog merged with earned achievements.
 * Earned first, then by tier (platinum → bronze). Array#sort is stable, like PHP 8 usort.
 */
export function badgeCollection(
  earnedByKind: Map<string, { earned_at: Date; xp: number }>,
) {
  const badges = Object.keys(BADGES).map((key) => {
    const row = earnedByKind.get(key);
    return {
      ...getBadge(key)!,
      earned: Boolean(row),
      earned_at: row?.earned_at ?? null,
    };
  });
  badges.sort((a, c) =>
    a.earned !== c.earned
      ? a.earned
        ? -1
        : 1
      : tierRank(c.tier) - tierRank(a.tier),
  );

  const total = Object.keys(BADGES).length;
  const earnedCount = earnedByKind.size;
  let totalXp = 0;
  for (const v of earnedByKind.values()) totalXp += v.xp;

  return {
    badges,
    earned_count: earnedCount,
    total,
    total_xp: totalXp,
    completion_percent: total > 0 ? Math.round((earnedCount / total) * 100) : 0,
  };
}
