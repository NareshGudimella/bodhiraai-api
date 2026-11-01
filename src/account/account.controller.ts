import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { and, asc, eq, ne } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../auth/password';
import { TokenService } from '../auth/token.service';
import { userResource } from '../auth/user.resource';
import {
  CurrentTokenId,
  CurrentUser,
} from '../common/decorators/auth.decorators';
import { LIMITS, RateLimit } from '../common/decorators/rate-limit';
import { ValidationFailed } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { parseLaravelDate } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { DB, type Db } from '../db/db';
import { users as usersTable } from '../db/schema';
import type { users } from '../db/types';
import { StorageService } from '../storage/storage.service';
import type { IncomingFile } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFile,
} from '../storage/uploads';

/** Profile fields shared with the teacher roster forms. */
export const PROFILE_RULES = {
  name: ['required', 'string', 'max:255'],
  phone: ['nullable', 'string', 'max:30'],
  dob: ['nullable', 'date', 'before:today'],
  gender: ['nullable', 'in:male,female,other'],
};

/** DATE column value for a validated `dob`. */
export const dobValue = (v: unknown) =>
  typeof v === 'string'
    ? new Date(
        `${parseLaravelDate(v)!.stored.toISOString().slice(0, 10)}T00:00:00Z`,
      )
    : null;

/** users.phone is unique in the DB; legacy surfaced a duplicate as a 500. */
export async function assertPhoneFree(
  db: Db,
  phone: unknown,
  ignoreId?: bigint,
) {
  if (typeof phone !== 'string') return;
  const taken = await db.query.users.findFirst({
    where: and(
      eq(usersTable.phone, phone),
      ignoreId ? ne(usersTable.id, ignoreId) : undefined,
    ),
    columns: { id: true },
    orderBy: [asc(usersTable.id)],
  });
  if (taken)
    throw new ValidationFailed({
      phone: ['The phone has already been taken.'],
    });
}

/**
 * New (not in the legacy API): account settings for every role, ported from the
 * legacy web AccountController / StudentController profileUpdate + passwordUpdate.
 */
@Controller('me')
export class AccountController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly tokens: TokenService,
  ) {}

  /** Multipart: name, phone, dob, gender, and an optional `avatar` image (≤4 MB). */
  /**
   * Legacy LocaleController (web): save the chosen language on the user
   * (forceFill(['locale'])->save(), so an unchanged choice writes nothing).
   */
  @Post('locale')
  @HttpCode(200)
  async locale(@CurrentUser() user: users, @Body() body: unknown) {
    const { locale } = (await laravelValidate(this.db, body, {
      locale: ['required', 'in:en,hi,te'],
    })) as { locale: string };
    if (user.locale !== locale) {
      await this.db
        .update(usersTable)
        .set({ locale, updated_at: new Date() })
        .where(eq(usersTable.id, user.id));
    }
    return ok({ locale }, 'Language updated.');
  }

  @Post('profile')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('avatar', uploadOptions(12)))
  async profile(
    @CurrentUser() user: users,
    @Body() body: unknown,
    @UploadedFile() avatar?: IncomingFile,
  ) {
    const data = await validateWithFile(this.db, body, PROFILE_RULES, avatar, {
      field: 'avatar',
      kind: 'image',
      maxKb: 4096,
    });
    await assertPhoneFree(this.db, data.phone, user.id);
    const url = avatar
      ? await storeOrReject('avatar', () =>
          this.storage.storeCloud(avatar, 'image'),
        )
      : undefined;

    await this.db
      .update(usersTable)
      .set({
        // `$user->update($validated)`: only the fields that were sent.
        ...('name' in data && { name: data.name as string }),
        ...('phone' in data && { phone: data.phone as string | null }),
        ...('dob' in data && { dob: dobValue(data.dob) }),
        ...('gender' in data && { gender: data.gender as string | null }),
        ...(url && { avatar: url }),
        updated_at: new Date(),
      })
      .where(eq(usersTable.id, user.id));
    const updated = await this.db.query.users.findFirst({
      where: eq(usersTable.id, user.id),
      with: { schools: true },
    });
    if (!updated) throw new Error(`No users record for id ${user.id}`);
    if (url) await this.storage.delete(user.avatar);
    return ok(userResource(updated), 'Profile updated successfully.');
  }

  // security: not in legacy: rate-limited like login (per user), since it checks the current password.
  @RateLimit(LIMITS.auth, 'user')
  @Post('password')
  @HttpCode(200)
  async password(
    @CurrentUser() user: users,
    @CurrentTokenId() tokenId: bigint,
    @Body() body: unknown,
  ) {
    // Laravel: current_password => required|current_password,
    //          password => required|confirmed|min:8|different:current_password
    let errors: Record<string, string[]> = {};
    let data: Record<string, unknown> = {};
    try {
      data = await laravelValidate(this.db, body, {
        current_password: ['required'],
        password: [
          'required',
          'confirmed',
          'min:8',
          'different:current_password',
        ],
      });
    } catch (e) {
      if (!(e instanceof ValidationFailed)) throw e;
      errors = (e.getResponse() as { errors: Record<string, string[]> }).errors;
    }
    const current = (body as Record<string, unknown> | null)?.current_password;
    if (
      !errors.current_password &&
      !(await verifyPassword(
        typeof current === 'string' ? current : '',
        user.password,
      ))
    ) {
      errors = { current_password: ['The password is incorrect.'], ...errors };
    }
    if (Object.keys(errors).length) throw new ValidationFailed(errors);

    await this.db
      .update(usersTable)
      .set({
        password: await hashPassword(data.password as string),
        updated_at: new Date(),
      })
      .where(eq(usersTable.id, user.id));
    // security: not in legacy: every other session is signed out; this one stays.
    await this.tokens.revokeAllForUser(user.id, tokenId);
    return ok(null, 'Password changed successfully.');
  }
}
