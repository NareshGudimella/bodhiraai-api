import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  lt,
  notInArray,
  sql,
} from 'drizzle-orm';
import { ApiException } from '../common/http/api.exception';
import { schoolOf } from '../common/direct-school';
import { modelNotFound } from '../common/http/laravel';
import { strLimit } from '../common/http/php-strings';
import { DB, type Db } from '../db/db';
import { countOf, myDesc, mySum } from '../db/helpers';
import {
  ai_chat_messages,
  ai_chat_sessions as sessionsTable,
  chapters,
  lesson_progress,
  quiz_attempts,
  schools,
  subjects,
} from '../db/schema';
import type { ai_chat_sessions, users } from '../db/types';
import { approxTokens, stubResponse, SYSTEM_PROMPT } from './ai-tutor';
import { ClaudeClient, maxReplyTokens } from './claude.client';

const NEW_TITLE = 'New conversation';

/** security: not in legacy. History sent to Claude is capped by size (characters) as well as by the last 10 turns. */
export const HISTORY_MAX_CHARS = 8000;

/** Newest turns that fit in `maxChars`, oldest first, starting with a user turn (the API requires it). */
export function capHistory<T extends { role: string; content: string }>(
  newestFirst: T[],
  maxChars = HISTORY_MAX_CHARS,
): T[] {
  const kept: T[] = [];
  let total = 0;
  for (const m of newestFirst) {
    total += [...m.content].length;
    if (total > maxChars) break;
    kept.unshift(m);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

type Reader = Pick<Db, 'select'>;

/**
 * Laravel's now() as stored: whole seconds, truncated. These columns have no
 * fractional seconds and PostgreSQL would round, which can date a reply after a
 * session started a moment later and reorder the session list.
 */
function nowSeconds() {
  const d = new Date();
  d.setUTCMilliseconds(0);
  return d;
}

function startOfTodayUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Port of App\Services\AiService. */
@Injectable()
export class AiService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly claude: ClaudeClient,
  ) {}

  sessions(user: users) {
    return this.db.query.ai_chat_sessions.findMany({
      where: eq(sessionsTable.user_id, user.id),
      orderBy: (t) => [
        myDesc(t.last_message_at),
        myDesc(t.updated_at),
        asc(t.id),
      ],
      extras: (t) => ({
        messages_count: countOf(ai_chat_messages, 'session_id', t.id).as(
          'messages_count',
        ),
      }),
    });
  }

  async startSession(user: users, title?: string | null) {
    const now = nowSeconds();
    const [row] = await this.db
      .insert(sessionsTable)
      .values({
        user_id: user.id,
        title: title || NEW_TITLE,
        mode: 'chat',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /** Route binding + AiApiController::guard. */
  async ownSession(user: users, id: bigint) {
    const session = await this.db.query.ai_chat_sessions.findFirst({
      where: eq(sessionsTable.id, id),
    });
    if (!session) throw modelNotFound('AiChatSession', id);
    if (session.user_id !== user.id)
      throw new ApiException('Not your conversation.', 403);
    return session;
  }

  messages(sessionId: bigint) {
    return this.db.query.ai_chat_messages.findMany({
      where: eq(ai_chat_messages.session_id, sessionId),
      orderBy: [asc(ai_chat_messages.id)],
    });
  }

  /** Tokens spent on the tutor today (UTC day), across all of the user's sessions. */
  async tokensUsedToday(user: users, q: Reader = this.db) {
    const [r] = await q
      .select({ tokens: mySum(ai_chat_messages.tokens) })
      .from(ai_chat_messages)
      .innerJoin(
        sessionsTable,
        eq(sessionsTable.id, ai_chat_messages.session_id),
      )
      .where(
        and(
          eq(sessionsTable.user_id, user.id),
          gte(ai_chat_messages.created_at, startOfTodayUtc()),
          lt(
            ai_chat_messages.created_at,
            new Date(startOfTodayUtc().getTime() + 86_400_000),
          ),
        ),
      );
    return r.tokens ?? 0;
  }

  /** The school's override, else AI_DAILY_TOKEN_LIMIT (default 5000). A 0 override falls through. */
  async dailyTokenLimit(user: users) {
    // Bodhira Direct members get the platform default, like legacy B2C.
    const schoolId = await schoolOf(this.db, user);
    const school = schoolId
      ? await this.db.query.schools.findFirst({
          where: eq(schools.id, schoolId),
          columns: { ai_daily_token_limit: true },
        })
      : null;
    return (
      school?.ai_daily_token_limit ||
      Number(process.env.AI_DAILY_TOKEN_LIMIT) ||
      5000
    );
  }

  async remainingTokens(user: users) {
    return Math.max(
      0,
      (await this.dailyTokenLimit(user)) - (await this.tokensUsedToday(user)),
    );
  }

  async tokenStatus(user: users) {
    const limit = await this.dailyTokenLimit(user);
    const used = Math.min(limit, await this.tokensUsedToday(user));
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      percent: limit > 0 ? Math.round((used / limit) * 100) : 100,
    };
  }

  async sendMessage(owner: users, session: ai_chat_sessions, body: string) {
    // History before this question: last 10 user/assistant turns, capped by size.
    const history = capHistory(
      await this.db.query.ai_chat_messages.findMany({
        where: and(
          eq(ai_chat_messages.session_id, session.id),
          inArray(ai_chat_messages.role, ['user', 'assistant']),
        ),
        orderBy: [desc(ai_chat_messages.id)],
        limit: 10,
      }),
    );

    // security: not in legacy: the budget is checked and reserved in one
    // transaction under a per-user lock, so parallel requests can't all pass
    // the check. A live call reserves its worst case (input estimate + max
    // reply); the real usage replaces it below. Without a key the canned reply
    // is metered as before.
    const live = this.claude.configured;
    const reserve = live
      ? approxTokens(
          SYSTEM_PROMPT + body + history.map((m) => m.content).join(''),
        ) + maxReplyTokens()
      : approxTokens(body);
    const limit = await this.dailyTokenLimit(owner);
    const now = nowSeconds();
    const user = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${owner.id}::bigint)`);
      if (limit - (await this.tokensUsedToday(owner, tx)) <= 0) {
        throw new ApiException(
          'Daily AI token limit reached. Your allowance resets tomorrow.',
          429,
        );
      }
      const [row] = await tx
        .insert(ai_chat_messages)
        .values({
          session_id: session.id,
          role: 'user',
          content: body,
          tokens: reserve,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row;
    });

    let title = session.title;
    const userTurns = await this.db.$count(
      ai_chat_messages,
      and(
        eq(ai_chat_messages.session_id, session.id),
        eq(ai_chat_messages.role, 'user'),
      ),
    );
    if (userTurns === 1 && (!title || title === NEW_TITLE)) {
      title = strLimit(body.trim(), 60, '…');
    }

    // Legacy loaded history *after* saving the question and then appended it again,
    // so Claude saw it twice. Sending it once is the only intended behaviour.
    let replied: Awaited<ReturnType<ClaudeClient['reply']>>;
    try {
      replied = await this.claude.reply(
        [
          ...history.map((m): Anthropic.MessageParam => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user', content: body },
        ],
        { sessionId: session.id },
      );
    } catch (e) {
      await this.settleUser(user.id, approxTokens(body));
      throw e;
    }
    const reply = replied?.text ?? stubResponse(body);
    const [userTokens, replyTokens] = replied
      ? [replied.inputTokens, replied.outputTokens]
      : [approxTokens(body), approxTokens(reply)];
    if (userTokens !== user.tokens) await this.settleUser(user.id, userTokens);
    user.tokens = userTokens;

    const done = nowSeconds();
    const [assistant] = await this.db
      .insert(ai_chat_messages)
      .values({
        session_id: session.id,
        role: 'assistant',
        content: reply,
        tokens: replyTokens,
        created_at: done,
        updated_at: done,
      })
      .returning();
    await this.db
      .update(sessionsTable)
      .set({ title, last_message_at: done, updated_at: done })
      .where(eq(sessionsTable.id, session.id));

    return { user, assistant, title };
  }

  /** Replaces a reservation with what was actually used. */
  private async settleUser(messageId: bigint, tokens: number) {
    await this.db
      .update(ai_chat_messages)
      .set({ tokens })
      .where(eq(ai_chat_messages.id, messageId));
  }

  /** Weak subjects (< 60% average) and the next lesson the student hasn't opened. */
  async recommendations(student: users) {
    const attempts = await this.db.query.quiz_attempts.findMany({
      where: and(
        eq(quiz_attempts.student_id, student.id),
        eq(quiz_attempts.status, 'submitted'),
      ),
      orderBy: [asc(quiz_attempts.id)],
      with: { quizzes: { with: { subjects: true } } },
    });

    const groups = new Map<string, typeof attempts>();
    for (const a of attempts) {
      const key = String(a.quizzes?.subjects?.id ?? 0);
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }

    const weak: Record<string, unknown>[] = [];
    for (const group of groups.values()) {
      const subject = group[0].quizzes?.subjects;
      if (!subject) continue;
      const avg = Math.round(
        group.reduce(
          (n, a) =>
            n + (a.total_marks > 0 ? (a.score / a.total_marks) * 100 : 0),
          0,
        ) / group.length,
      );
      if (avg < 60) {
        weak.push({
          subject_id: subject.id,
          subject: subject.name,
          icon: subject.icon,
          color: subject.color,
          avg_percent: avg,
          suggestion: `You're at ${avg}% in ${subject.name} — try the next practice chapter.`,
        });
      }
    }

    const schoolId = await schoolOf(this.db, student); // Bodhira Direct: none
    const started = await this.db.query.lesson_progress.findMany({
      where: eq(lesson_progress.student_id, student.id),
      columns: { lesson_id: true },
      orderBy: [asc(lesson_progress.id)],
    });
    const next = await this.db.query.lessons.findFirst({
      where: (t) =>
        and(
          notInArray(
            t.id,
            started.map((s) => s.lesson_id),
          ),
          exists(
            this.db
              .select({ x: sql`1` })
              .from(chapters)
              .innerJoin(subjects, eq(subjects.id, chapters.subject_id))
              .where(
                and(
                  eq(chapters.id, t.chapter_id),
                  schoolId ? eq(subjects.school_id, schoolId) : undefined,
                  student.grade ? eq(subjects.grade, student.grade) : undefined,
                ),
              ),
          ),
        ),
      orderBy: (t) => [asc(t.chapter_id), asc(t.sort_order), asc(t.id)],
      with: { chapters: { with: { subjects: true } } },
    });

    return {
      weak_areas: weak,
      next_lesson: next
        ? {
            id: next.id,
            title: next.title,
            subject: next.chapters?.subjects?.name ?? null,
            chapter: next.chapters?.title ?? null,
            type: next.type,
          }
        : null,
    };
  }
}
