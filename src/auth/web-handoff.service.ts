import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { ValidationFailed } from '../common/http/api.exception';
import { DB, type Db } from '../db/db';
import { users as usersTable, web_handoff_codes } from '../db/schema';
import type { users } from '../db/types';
import { AuthService } from './auth.service';
import { isSafeNextPath } from './web-handoff';

/** How long an issued code can be redeemed. */
export const HANDOFF_TTL_MS = 60_000;

const invalidCode = () =>
  ValidationFailed.field(
    'code',
    'This sign-in link is invalid or has expired.',
  );

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * not in legacy: signs a mobile app's user into the web without a second
 * login. The app asks for a single-use code bound to a page (`next`), opens
 * the returned URL in the browser, and the web redeems the code for a session.
 */
@Injectable()
export class WebHandoffService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  async issue(user: users, body: unknown) {
    const next = (body as { next?: unknown } | null | undefined)?.next;
    if (next === undefined || next === null || next === '') {
      throw ValidationFailed.field('next', 'The next field is required.');
    }
    if (!isSafeNextPath(next)) {
      throw ValidationFailed.field(
        'next',
        'The next field must be a relative path starting with a single /.',
      );
    }

    const code = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.db.insert(web_handoff_codes).values({
      user_id: user.id,
      code_hash: sha256(code),
      next,
      expires_at: new Date(now.getTime() + HANDOFF_TTL_MS),
      created_at: now,
    });
    // Housekeeping: codes are useless after a minute; keep an hour for support.
    await this.db
      .delete(web_handoff_codes)
      .where(
        lt(web_handoff_codes.expires_at, new Date(now.getTime() - 3_600_000)),
      );

    const web = (process.env.WEB_URL ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    );
    return { url: `${web}/auth/handoff?code=${encodeURIComponent(code)}` };
  }

  /** The `code` field, validated like redeem does. */
  private codeFrom(body: unknown): string {
    const code = (body as { code?: unknown } | null | undefined)?.code;
    if (code === undefined || code === null || code === '') {
      throw ValidationFailed.field('code', 'The code field is required.');
    }
    if (typeof code !== 'string' || code.length > 200) {
      throw ValidationFailed.field('code', 'The code field must be a string.');
    }
    return code;
  }

  /**
   * security/not in legacy: `{ name, role }` of the user a valid, unexpired,
   * unused code would sign in, without consuming it. Invalid: the same 422 as redeem.
   */
  async peek(body: unknown) {
    const code = this.codeFrom(body);
    const [row] = await this.db
      .select({
        name: usersTable.name,
        role: usersTable.role,
        status: usersTable.status,
      })
      .from(web_handoff_codes)
      .innerJoin(usersTable, eq(usersTable.id, web_handoff_codes.user_id))
      .where(
        and(
          eq(web_handoff_codes.code_hash, sha256(code)),
          isNull(web_handoff_codes.used_at),
          gt(web_handoff_codes.expires_at, new Date()),
        ),
      );
    if (!row || row.status !== 'active') throw invalidCode();
    return { name: row.name, role: row.role };
  }

  /** Consumes an unexpired, unused code (one UPDATE, so two redeems can't both win). */
  async redeem(body: unknown) {
    const code = this.codeFrom(body);

    const now = new Date();
    const [row] = await this.db
      .update(web_handoff_codes)
      .set({ used_at: now })
      .where(
        and(
          eq(web_handoff_codes.code_hash, sha256(code)),
          isNull(web_handoff_codes.used_at),
          gt(web_handoff_codes.expires_at, now),
        ),
      )
      .returning();
    const user = row
      ? await this.db.query.users.findFirst({
          where: eq(usersTable.id, row.user_id),
        })
      : undefined;
    // Same shape as a failed login (422 under the credential's field).
    if (!row || !user) throw invalidCode();

    const session = await this.auth.loginSession(user, 'web-handoff');
    return { ...session, next: row.next };
  }
}
