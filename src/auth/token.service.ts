import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { phpJsonEncode } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { personal_access_tokens, users as usersTable } from '../db/schema';
import type { users } from '../db/types';

/** Laravel morph class stored in personal_access_tokens.tokenable_type. */
const USER_MORPH = 'App\\Models\\User';
const ALPHANUM =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const DAY_MS = 86_400_000;
/** security: not in legacy. Web sessions match the web cookie's maxAge (bodhiraai-ui/src/lib/session.ts). */
export const WEB_TOKEN_TTL_MS = 30 * DAY_MS;
/** security: not in legacy. Mobile tokens die after this long unused (sliding, from last_used_at)... */
export const MOBILE_IDLE_TTL_MS = 90 * DAY_MS;
/** ...and this long after issue whatever the activity. */
export const MOBILE_ABSOLUTE_TTL_MS = 365 * DAY_MS;

/** How stale `last_used_at` may get before a request rewrites it. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** Token names (the login `device`) issued to the Next.js web app. */
const WEB_DEVICES = new Set(['web', 'web-handoff']);
export const isWebDevice = (name: string) => WEB_DEVICES.has(name);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Sanctum-compatible personal access tokens.
 *
 * Plain token: `<id>|<40 random chars>`; the DB stores sha256 of the random part.
 * Tokens issued by the legacy Laravel app keep working here and vice versa.
 */
@Injectable()
export class TokenService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async issue(user: users, name: string, abilities: string[]): Promise<string> {
    const bytes = randomBytes(40);
    const secret = Array.from(bytes, (b) => ALPHANUM[b % ALPHANUM.length]).join(
      '',
    );
    const now = new Date();
    // security: not in legacy: tokens expire (web 30 days, other devices 1 year absolute).
    const expires = new Date(
      now.getTime() +
        (isWebDevice(name) ? WEB_TOKEN_TTL_MS : MOBILE_ABSOLUTE_TTL_MS),
    );
    const [row] = await this.db
      .insert(personal_access_tokens)
      .values({
        tokenable_type: USER_MORPH,
        tokenable_id: user.id,
        name,
        token: sha256(secret),
        abilities: phpJsonEncode(abilities),
        expires_at: expires,
        created_at: now,
        updated_at: now,
      })
      .returning({ id: personal_access_tokens.id });
    return `${row.id}|${secret}`;
  }

  async resolve(
    plain: string,
  ): Promise<{ user: users; tokenId: bigint } | null> {
    const [idPart, secret] = plain.includes('|')
      ? plain.split('|', 2)
      : [null, plain];
    const hash = sha256(secret);

    const row =
      idPart && /^\d+$/.test(idPart)
        ? await this.db.query.personal_access_tokens.findFirst({
            where: eq(personal_access_tokens.id, BigInt(idPart)),
          })
        : await this.db.query.personal_access_tokens.findFirst({
            where: eq(personal_access_tokens.token, hash),
          });

    if (!row || row.tokenable_type !== USER_MORPH) return null;
    if (!timingSafeEqual(Buffer.from(row.token), Buffer.from(hash)))
      return null;
    if (!this.isLive(row)) return null;

    const user = await this.db.query.users.findFirst({
      where: eq(usersTable.id, row.tokenable_id),
    });
    if (!user) return null;
    // security: not in legacy: a blocked, on-hold or inactive account's tokens stop
    // working at once (401, like an invalid token; login explains with a 403).
    if (user.status !== 'active') return null;

    // Best-effort bookkeeping, like Sanctum, but at most once a minute per token
    // (Sanctum writes on every request; the idle expiry only needs days).
    const now = Date.now();
    if (
      !row.last_used_at ||
      now - row.last_used_at.getTime() >= LAST_USED_RESOLUTION_MS
    ) {
      await this.db
        .update(personal_access_tokens)
        .set({ last_used_at: new Date(now) })
        .where(eq(personal_access_tokens.id, row.id))
        .catch(() => undefined);
    }
    return { user, tokenId: row.id };
  }

  /**
   * security: not in legacy. Expiry rules, applied to tokens issued by the
   * legacy app too (their `expires_at` is null): the stored `expires_at`, the
   * 30-day web lifetime, and for other devices 90 days idle / 1 year absolute.
   */
  private isLive(row: {
    name: string;
    expires_at: Date | null;
    created_at: Date | null;
    last_used_at: Date | null;
  }): boolean {
    const now = Date.now();
    if (row.expires_at && row.expires_at.getTime() < now) return false;
    const created = row.created_at?.getTime();
    if (created === undefined) return true;
    if (isWebDevice(row.name)) return created + WEB_TOKEN_TTL_MS >= now;
    if (created + MOBILE_ABSOLUTE_TTL_MS < now) return false;
    const lastUsed = row.last_used_at?.getTime() ?? created;
    return lastUsed + MOBILE_IDLE_TTL_MS >= now;
  }

  revoke(tokenId: bigint) {
    return this.db
      .delete(personal_access_tokens)
      .where(eq(personal_access_tokens.id, tokenId));
  }

  revokeAll(userId: bigint) {
    return this.db
      .delete(personal_access_tokens)
      .where(
        and(
          eq(personal_access_tokens.tokenable_type, USER_MORPH),
          eq(personal_access_tokens.tokenable_id, userId),
        ),
      );
  }

  /**
   * security: not in legacy. Signs a user out everywhere, optionally keeping
   * one token (the caller's own). Call it when an account is deactivated,
   * blocked, removed from a roster, or its password changes.
   */
  revokeAllForUser(userId: bigint, exceptTokenId?: bigint | null) {
    return this.db
      .delete(personal_access_tokens)
      .where(
        and(
          eq(personal_access_tokens.tokenable_type, USER_MORPH),
          eq(personal_access_tokens.tokenable_id, userId),
          exceptTokenId
            ? ne(personal_access_tokens.id, exceptTokenId)
            : undefined,
        ),
      );
  }
}
