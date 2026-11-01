import { strLimit } from '../common/http/php-strings';

/** Pure helpers ported from App\Services\AiService (no I/O). */

export const SYSTEM_PROMPT = `You are Bodhira, a friendly and encouraging AI tutor for K-12 students in India.

Style:
- Concise. 4-6 short paragraphs max unless the student asks for depth.
- Use **bold** to highlight key terms (Markdown style). Use bullet lists where helpful.
- Explain concepts step by step, like a patient teacher.
- When solving math, show each step.
- End with a short check-in question to keep the conversation going.

Boundaries:
- Stay focused on academics, study skills, and exam prep.
- If asked something off-topic or unsafe, gently redirect to learning.
- Don't claim to be human. Don't share private user data.`;

/** ceil(mb_strlen / 4), at least 1. mb_strlen counts code points. */
export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil([...text].length / 4));
}

/** PHP trim() default character set. */
export function phpTrim(value: string): string {
  return value.replace(/^[ \t\n\r\v\0]+|[ \t\n\r\v\0]+$/g, '');
}

/** PHP strtolower(): ASCII only since PHP 8.2. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** PHP float → string (precision=14), e.g. 1/3 → "0.33333333333333". */
function phpNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(14)));
}

const TOPICS: { keys: string[]; reply: string }[] = [
  {
    keys: ['photosynthesis'],
    reply:
      '**Photosynthesis** is how plants convert sunlight into chemical energy:\n\n• Carbon dioxide + Water + Light → Glucose + Oxygen\n• Happens in chloroplasts, powered by chlorophyll\n• Two stages: light-dependent reactions and the Calvin cycle\n\nWant me to dive deeper into either stage?',
  },
  {
    keys: ['polynomial'],
    reply:
      "A **polynomial** is an expression with terms made of constants and variables raised to whole-number powers, e.g. `2x² + 3x − 5`.\n\nKey concepts:\n• **Degree** — highest exponent (here, 2)\n• **Coefficients** — the numbers in front (2, 3, −5)\n• **Operations** — add/subtract by combining like terms; multiply by distributing\n\nShare a specific polynomial and I'll factor it with you.",
  },
  {
    keys: ['newton', 'motion', 'force'],
    reply:
      "**Newton's three laws of motion**:\n\n1. **Inertia** — an object stays at rest or in uniform motion unless a force acts on it.\n2. **F = m·a** — net force equals mass times acceleration.\n3. **Action-Reaction** — every action has an equal and opposite reaction.\n\nWhich one do you want to apply to a problem?",
  },
  {
    keys: ['fraction'],
    reply:
      "**Fractions 101** — a fraction shows part of a whole: `numerator / denominator`.\n\n• To **add/subtract**: get a common denominator, then combine numerators.\n• To **multiply**: numerator × numerator, denominator × denominator.\n• To **divide**: multiply by the reciprocal (flip and multiply).\n\nGive me an example like `2/3 + 5/6` and I'll work it through.",
  },
  {
    keys: ['quadratic'],
    reply:
      "**Quadratic equation**: `ax² + bx + c = 0`.\n\nThree solving methods:\n1. **Factoring** — works when the equation factors nicely\n2. **Quadratic formula** — `x = (−b ± √(b² − 4ac)) / 2a`\n3. **Completing the square** — useful for derivations\n\nDrop your equation and I'll solve it step by step.",
  },
  {
    keys: ['essay', 'paragraph', 'writing'],
    reply:
      "Strong writing has three layers:\n\n1. **Hook** — grab attention in the first sentence\n2. **Body** — one clear idea per paragraph, supported with evidence\n3. **Close** — tie back to the hook, end with a takeaway\n\nWhat's your topic? Share a draft and I'll suggest edits.",
  },
  {
    keys: ['cell', 'biology'],
    reply:
      'The **cell** is the basic unit of life. Two broad types:\n\n• **Prokaryotic** (e.g. bacteria) — no nucleus, simpler structure\n• **Eukaryotic** (plants, animals, fungi) — nucleus + membrane-bound organelles\n\nKey organelles: nucleus, mitochondria, ribosomes, ER, Golgi. Want me to explain any specific one?',
  },
];

/** AiService::stubResponse — the topic-aware canned reply used without an API key. */
export function stubResponse(question: string): string {
  const q = asciiLower(question);

  if (['hello', 'hi ', 'hey', 'namaste'].some((k) => q.includes(k))) {
    return "Hi there! 👋 I'm your study companion. Ask me anything about your subjects — concepts, problems, or revision tips. What are you working on today?";
  }

  // preg_match('/(\d+)\s*([+\-*\/xX])\s*(\d+)/') without /u: ASCII digits and whitespace.
  const m = /(\d+)[ \t\n\v\f\r]*([+\-*/xX])[ \t\n\v\f\r]*(\d+)/.exec(question);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[3], 10);
    const op = m[2] === 'x' || m[2] === 'X' ? '*' : m[2];
    const result =
      op === '+'
        ? a + b
        : op === '-'
          ? a - b
          : op === '*'
            ? a * b
            : op === '/' && b !== 0
              ? a / b
              : null;
    if (result !== null) {
      return `Quick math: **${m[1]} ${m[2]} ${m[3]} = ${phpNumber(result)}**.\n\nIf you want to walk through the steps, share the problem in more detail and I'll explain each operation.`;
    }
  }

  for (const t of TOPICS) {
    if (t.keys.some((k) => q.includes(k))) return t.reply;
  }

  const topic = strLimit(phpTrim(question), 80, '…');
  return `Good question — let's break **"${topic}"** down together.\n\nA useful way to approach it:\n\n1. **What's being asked?** Restate the question in your own words.\n2. **What do you already know?** List the relevant facts or formulas.\n3. **What's the gap?** Identify what you need to find or prove.\n4. **Strategy** — pick the method (e.g. example, formula, comparison).\n\nShare which step you're stuck at and I'll guide you from there. *(This is a stub response — wire \`ANTHROPIC_API_KEY\` for live AI answers.)*`;
}
