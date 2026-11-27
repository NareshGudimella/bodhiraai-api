import { NEW_PASSWORD_RULES } from '../common/http/rules';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { ValidationFailed } from '../common/http/api.exception';
import { laravelValidate } from '../common/http/laravel-validator';
import { DB, type Db } from '../db/db';
import { password_reset_tokens, users } from '../db/schema';
import { JobsService } from '../jobs/jobs.service';
import { MailService } from '../mail/mail.service';
import { strRandom } from '../storage/laravel-str';
import { hashPassword, verifyPassword } from './password';
import { TokenService } from './token.service';

/** Laravel's lang/en/passwords.php. */
export const PASSWORDS = {
  reset: 'Your password has been reset.',
  sent: 'We have emailed your password reset link.',
  throttled: 'Please wait before retrying.',
  token: 'This password reset token is invalid.',
  user: "We can't find a user with that email address.",
  // security: not in legacy — one answer for every address, so the form can't
  // be used to find out who has an account.
  neutral:
    'If an account exists for that email, we have emailed a password reset link.',
};

const EXPIRE_MIN = 60; // config/auth.php passwords.users.expire
const THROTTLE_S = 60; // passwords.users.throttle

/**
 * Port of Laravel's password broker as legacy uses it (PasswordResetController):
 * one row per email in password_reset_tokens with a bcrypt hash of the
 * token, so links issued by either app work in the other.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordReset');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly mail: MailService,
    private readonly tokens: TokenService,
    private readonly jobs: JobsService,
  ) {
    jobs.handle('password-reset', (d: { user: string }) =>
      this.sendEmail(BigInt(d.user)),
    );
  }

  private user(email: string) {
    return this.db.query.users.findFirst({
      where: eq(users.email, email),
      orderBy: [asc(users.id)],
    });
  }

  /**
   * Password::sendResetLink(). security: not in legacy — every valid address gets
   * PASSWORDS.neutral (unknown, throttled and sent alike), with the same work done
   * (a bcrypt hash) and the email sent in the background, so neither the answer
   * nor its timing reveals whether the address has an account.
   */
  async sendLink(body: unknown): Promise<string> {
    const { email } = (await laravelValidate(this.db, body, {
      email: ['required', 'email', 'max:160'],
    })) as { email: string };
    const user = await this.user(email);
    // Looked up for unknown addresses too, so every answer does the same work.
    const existing = await this.db.query.password_reset_tokens.findFirst({
      where: eq(password_reset_tokens.email, email),
    });
    const throttled =
      !!existing?.created_at &&
      existing.created_at.getTime() + THROTTLE_S * 1000 > Date.now();
    // The token's own hash is made with the email, in the background.
    await hashPassword(randomBytes(32).toString('hex'));
    if (user && !throttled) {
      // not in legacy: a `password-reset` job (the worker with REDIS_URL, else
      // in the background here). It carries only the user id, never the token,
      // and one job per user per minute (a quick second request adds none).
      await this.jobs.run(
        'password-reset',
        { user: String(user.id) },
        {
          jobId: `password-reset-${user.id}-${Math.floor(Date.now() / 60_000)}`,
          inline: 'background',
        },
      );
    }
    return PASSWORDS.neutral;
  }

  /**
   * Creates the token and sends ResetPasswordNotification (legacy sent it
   * synchronously). A retry issues a new token, replacing the old one.
   */
  private async sendEmail(userId: bigint) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true },
    });
    if (!user?.email) return;
    const email = user.email;
    // hash_hmac('sha256', Str::random(40), $key): 64 hex characters, sent in the link.
    const token = randomBytes(32).toString('hex');
    await this.db
      .delete(password_reset_tokens)
      .where(eq(password_reset_tokens.email, email));
    await this.db.insert(password_reset_tokens).values({
      email,
      token: await hashPassword(token),
      created_at: new Date(),
    });

    const web = (process.env.WEB_URL ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    );
    const url = `${web}/reset-password/${token}?email=${encodeURIComponent(email)}`;
    await this.mail.send({
      to: { address: email, name: user.name },
      subject: 'Reset your Bodhira password',
      text: [
        `Hi ${user.name},`,
        '',
        'You requested a password reset for your Bodhira account. Click the button below to set a new password.',
        '',
        `Reset Password: ${url}`,
        '',
        'This link expires in 60 minutes.',
        '',
        "If you didn't request this, you can safely ignore this email.",
      ].join('\n'),
    });
  }

  /** Password::reset(): checks the token, sets the password, rotates remember_token, deletes the token. */
  async reset(body: unknown): Promise<string> {
    const data = (await laravelValidate(this.db, body, {
      token: ['required', 'string', 'max:255'],
      email: ['required', 'email', 'max:160'],
      password: ['required', 'string', ...NEW_PASSWORD_RULES, 'confirmed'],
    })) as { token: string; email: string; password: string };

    const user = await this.user(data.email);
    if (!user) throw ValidationFailed.field('email', PASSWORDS.user);
    const row = await this.db.query.password_reset_tokens.findFirst({
      where: eq(password_reset_tokens.email, data.email),
    });
    const fresh =
      row?.created_at &&
      row.created_at.getTime() + EXPIRE_MIN * 60_000 > Date.now();
    if (
      !row ||
      !fresh ||
      !(await verifyPassword(String(data.token), row.token))
    ) {
      throw ValidationFailed.field('email', PASSWORDS.token);
    }

    await this.db
      .update(users)
      .set({
        password: await hashPassword(data.password),
        remember_token: strRandom(60),
        updated_at: new Date(),
      })
      .where(eq(users.id, user.id));
    await this.db
      .delete(password_reset_tokens)
      .where(eq(password_reset_tokens.email, data.email));
    // security: not in legacy: a reset signs the account out everywhere.
    await this.tokens.revokeAllForUser(user.id);
    this.logger.log(`Password reset for user ${user.id}`);
    return PASSWORDS.reset;
  }
}
