import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import { numberFormat } from '../common/http/laravel';
import { gIA, mY, mjY, truthy } from './student-report';

/**
 * resources/views/student/report.blade.php, drawn with pdfkit on A4 (DejaVu
 * Sans, as dompdf). Same sections, labels and order; positions are close, not
 * pixel-exact. dompdf applies `text-transform: uppercase` to the table headings
 * and stat labels, so they are upper-cased here too.
 */

const FONTS = resolve(__dirname, '../../assets/fonts');
const C = {
  ink: '#1A0A0C',
  brand: '#2A0E13',
  gold: '#E2B873',
  muted: '#6B4A38',
  cream: '#E8D4B8',
  stat: '#FBF6EF',
  th: '#F0E0C8',
  row: '#EEEEEE',
  pass: '#15803D',
  fail: '#BE123C',
  foot: '#A8896A',
};

export interface ReportAttempt {
  title: string | null;
  subject: string | null;
  score: number;
  total_marks: number;
  pass_marks: number | null;
  submitted_at: Date | null;
}

export interface ReportData {
  student: {
    name: string;
    email: string | null;
    phone: string | null;
    grade: string | null;
    created_at: Date | null;
  };
  board: string | null;
  school: string | null;
  xp: number;
  streak_days: number;
  lessons_completed: number;
  quizzes_attempted: number;
  avg_score_percent: number;
  badges_count: number;
  attempts: ReportAttempt[];
  attendance: {
    total: number;
    present: number;
    late: number;
    excused: number;
    absent: number;
    percent: number;
  };
  aiUsage: { sessions: number; messages: number; tokens: number };
  generated_at: Date;
}

const PAGE_H = 842;
const L = 20;
const W = 595 - 2 * L;
const BOTTOM = PAGE_H - 30;

export function renderStudentReportPdf(d: ReportData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: {
      Title: `Student Report - ${d.student.name}`,
      Producer: 'Bodhira.ai',
    },
  });
  doc.registerFont('sans', `${FONTS}/DejaVuSans.ttf`);
  doc.registerFont('bold', `${FONTS}/DejaVuSans-Bold.ttf`);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((ok, fail) => {
    doc.on('end', () => ok(Buffer.concat(chunks)));
    doc.on('error', fail);
  });

  const level = Math.trunc(Math.trunc(d.xp) / 70);
  const board = d.board;
  const grade = truthy(d.student.grade) ? `Grade ${d.student.grade}` : '';
  let y = 0;

  const ensure = (h: number) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = 30;
    }
  };
  const height = (s: string, w: number, font: string, size: number) =>
    doc.font(font).fontSize(size).heightOfString(s, { width: w });
  const put = (
    s: string,
    x: number,
    yy: number,
    w: number,
    o: {
      font?: string;
      size?: number;
      color?: string;
      align?: 'left' | 'center';
      spacing?: number;
    } = {},
  ) => {
    doc
      .font(o.font ?? 'sans')
      .fontSize(o.size ?? 9)
      .fillColor(o.color ?? C.ink)
      .text(s, x, yy, {
        width: w,
        align: o.align ?? 'left',
        characterSpacing: o.spacing ?? 0,
      });
  };

  // Header band.
  const sub =
    `${grade}${board ? ` · ${board}` : ''} · ${d.school ?? 'Individual Learner'} · Generated ${mjY(d.generated_at)} · ${gIA(d.generated_at)}`
      .replace(/\s+/g, ' ')
      .trim();
  const subH = height(sub, W - 20, 'sans', 8.25);
  const headH = 16.5 + 11 + 3 + 18 + 3 + subH + 16.5;
  doc.rect(0, 0, 595, headH).fill(C.brand);
  put('BODHIRA.AI — STUDENT REPORT', L, 16.5, W, {
    size: 8.25,
    color: C.gold,
  });
  put(d.student.name, L, 31, W, { font: 'bold', size: 18, color: '#FFFFFF' });
  put(sub, L, 55, W - 20, { size: 8.25, color: C.cream });
  y = headH + 16.5;

  const h2 = (title: string) => {
    ensure(50);
    y += 16.5;
    put(title, L, y, W, { font: 'bold', size: 10.5, color: C.brand });
    y += 16;
    doc
      .moveTo(L, y)
      .lineTo(L + W, y)
      .lineWidth(1.5)
      .strokeColor(C.gold)
      .stroke();
    y += 8;
  };

  const statRow = (cells: [string, string][]) => {
    const cw = W / cells.length;
    ensure(46);
    cells.forEach(([v, l], i) => {
      const x = L + i * cw;
      doc.rect(x, y, cw, 42).fillAndStroke(C.stat, C.cream);
      put(v, x, y + 7, cw, {
        font: 'bold',
        size: 15,
        color: C.brand,
        align: 'center',
      });
      put(l.toUpperCase(), x, y + 27, cw, {
        size: 6.75,
        color: C.muted,
        align: 'center',
      });
    });
    y += 42;
  };

  // Student details.
  h2('Student Details');
  const dash = (s: string | null) => s ?? '—';
  const kv: [string, string, string, string][] = [
    ['Name', d.student.name, 'Email', dash(d.student.email)],
    [
      'Grade',
      truthy(d.student.grade) ? `Grade ${d.student.grade}` : '—',
      'Phone',
      dash(d.student.phone),
    ],
    [
      'Board / Syllabus',
      dash(board),
      'Member Since',
      d.student.created_at ? mY(d.student.created_at) : '—',
    ],
  ];
  const kw = W * 0.17;
  const vw = W * 0.33;
  for (const [k1, v1, k2, v2] of kv) {
    const h =
      Math.max(
        height(v1, vw - 12, 'sans', 9),
        height(v2, vw - 12, 'sans', 9),
        height(k1, kw - 12, 'bold', 9),
      ) + 8;
    ensure(h);
    put(k1, L + 6, y + 4, kw - 12, { font: 'bold', color: C.muted });
    put(v1, L + kw + 6, y + 4, vw - 12, {});
    put(k2, L + kw + vw + 6, y + 4, kw - 12, { font: 'bold', color: C.muted });
    put(v2, L + 2 * kw + vw + 6, y + 4, vw - 12, {});
    y += h;
  }

  // Statistics.
  h2('Statistics');
  statRow([
    [numberFormat(Math.trunc(d.xp)), `XP · Lvl ${level}`],
    [String(d.streak_days), 'Day Streak'],
    [String(d.lessons_completed), 'Lessons'],
    [String(d.quizzes_attempted), 'Quizzes'],
    [`${d.avg_score_percent}%`, 'Avg Score'],
    [String(d.badges_count), 'Badges'],
  ]);

  // Quiz results.
  h2(`Test & Quiz Results (${d.attempts.length})`);
  if (d.attempts.length) {
    const cols = [0.4, 0.19, 0.1, 0.08, 0.1, 0.13].map((f) => f * W);
    const xs = cols.map(
      (_, i) => L + cols.slice(0, i).reduce((a, b) => a + b, 0),
    );
    const head = () => {
      ensure(40);
      doc.rect(L, y, W, 24).fill(C.th);
      ['Test', 'Subject', 'Score', '%', 'Result', 'Date'].forEach((t, i) =>
        put(t.toUpperCase(), xs[i] + 6, y + 9, cols[i] - 12, {
          font: 'bold',
          size: 6.75,
          color: C.muted,
        }),
      );
      y += 24;
    };
    head();
    for (const a of d.attempts) {
      const pct =
        a.total_marks > 0 ? Math.round((a.score / a.total_marks) * 100) : 0;
      const passed = a.pass_marks !== null && a.score >= a.pass_marks;
      const cells = [
        a.title ?? 'Quiz',
        a.subject ?? '—',
        `${a.score}/${a.total_marks}`,
        `${pct}%`,
        passed ? 'Passed' : 'Failed',
        a.submitted_at ? mjY(a.submitted_at) : '',
      ];
      const h =
        Math.max(
          ...cells.map((c, i) => height(c, cols[i] - 12, 'sans', 8.25)),
        ) + 12;
      if (y + h > BOTTOM) {
        doc.addPage();
        y = 30;
        head();
      }
      cells.forEach((c, i) =>
        put(c, xs[i] + 6, y + 6, cols[i] - 12, {
          size: 8.25,
          ...(i === 4 ? { font: 'bold', color: passed ? C.pass : C.fail } : {}),
        }),
      );
      y += h;
      doc
        .moveTo(L, y)
        .lineTo(L + W, y)
        .lineWidth(0.75)
        .strokeColor(C.row)
        .stroke();
    }
  } else {
    ensure(20);
    put('No quiz attempts yet.', L, y + 4, W, { color: C.muted });
    y += 20;
  }

  // Attendance.
  h2('Attendance');
  const at = d.attendance;
  if (at.total > 0) {
    statRow([
      [`${at.percent}%`, 'Present'],
      [String(at.present), 'Present'],
      [String(at.late), 'Late'],
      [String(at.excused), 'Excused'],
      [String(at.absent), 'Absent'],
      [String(at.total), 'Total Days'],
    ]);
  } else {
    ensure(20);
    put('No attendance records.', L, y + 4, W, { color: C.muted });
    y += 20;
  }

  // AI tutor usage.
  h2('AI Tutor Usage');
  statRow([
    [numberFormat(d.aiUsage.sessions), 'Conversations'],
    [numberFormat(d.aiUsage.messages), 'Messages'],
    [numberFormat(d.aiUsage.tokens), 'Tokens Used'],
  ]);

  // Footer.
  ensure(50);
  y += 24;
  doc
    .moveTo(L, y)
    .lineTo(L + W, y)
    .lineWidth(0.75)
    .strokeColor(C.cream)
    .stroke();
  y += 10;
  put(
    `This report was generated by Bodhira.ai on ${mjY(d.generated_at)} at ${gIA(d.generated_at)}. © ${d.generated_at.getUTCFullYear()} Bodhira.ai.`,
    L,
    y,
    W,
    { size: 6.75, color: C.foot, align: 'center' },
  );

  doc.end();
  return done;
}
