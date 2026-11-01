import { Inject, Injectable } from '@nestjs/common';
import { seatsUsed } from '../common/seats';
import { randomInt } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { isDevelopment, otpLoginEnabled } from '../config/env';
import { ApiException, ValidationFailed } from '../common/http/api.exception';
import { phpJsonEncode } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { toModel } from '../common/http/eloquent';
import { abilitiesFor, Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { directSchoolId } from '../common/direct-school';
import {
  otp_attempts,
  plans,
  schools,
  subscriptions,
  syllabi,
  users as usersTable,
} from '../db/schema';
import type { users } from '../db/types';
import {
  LoginDto,
  RegisterDto,
  SendOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { hashPassword, verifyPassword } from './password';
import { TokenService } from './token.service';
import { userResource } from './user.resource';

/** Port of App\Http\Controllers\Web\AuthController::detectField. */
export function detectField(value: string): 'email' | 'phone' | 'username' {
  const v = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
  if (/^\+?[0-9\s\-()]+$/.test(v) && v.replace(/\D/g, '').length >= 7)
    return 'phone';
  return 'username';
}

/** security: not in legacy. Wrong OTP codes allowed before the code is invalidated. */
export const OTP_MAX_ATTEMPTS = 5;

/** security: not in legacy. Roles that may sign in with a phone OTP (never the admin and CMS roles). */
const OTP_ROLES: string[] = [Role.Student, Role.Teacher, Role.Parent];

/** security: not in legacy. Roles that self-register as pending until the school approves. */
const NEEDS_APPROVAL: string[] = [Role.Teacher, Role.Parent];

/** Digits only, so `+91 98123-45670` and `919812345670` count as one phone. */
export const phoneKey = (phone: string) => phone.replace(/\D/g, '');

const DEFAULT_INACTIVE = 'Your account is not active. Contact support.';
const INACTIVE_MESSAGES: Record<string, string> = {
  // security: not in legacy API (the legacy web login says these): tell the user why.
  on_hold:
    'Your account is awaiting approval from your school, or is on hold. Please contact your school.',
  blocked: 'Your account has been blocked. Please contact your school.',
};

/** The 403 for a user whose status isn't `active` (password login, OTP, handoff). */
export const accountInactive = (status: string) =>
  new ApiException(
    INACTIVE_MESSAGES[status] ?? DEFAULT_INACTIVE,
    403,
    'account_inactive',
  );

/** A real bcrypt hash to compare against when the account doesn't exist (constant-ish login time). */
let dummyHash: Promise<string> | null = null;
const dummyPasswordHash = () => (dummyHash ??= hashPassword('not-a-password'));

/** Port of App\Http\Controllers\Api\V1\AuthController. */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: TokenService,
  ) {}

  /** The user with its school (`findUniqueOrThrow`: a missing row is a 500). */
  private async withSchool(id: bigint) {
    const row = await this.db.query.users.findFirst({
      where: eq(usersTable.id, id),
      with: { schools: true },
    });
    if (!row) throw new Error(`No users record for id ${id}`);
    return row;
  }

  private async session(user: users, device?: string) {
    const withSchool = await this.withSchool(user.id);
    const token = await this.tokens.issue(
      user,
      device ?? 'api',
      abilitiesFor(user.role),
    );
    return { user: userResource(withSchool), token, token_type: 'Bearer' };
  }

  async register(dto: RegisterDto) {
    const errors: Record<string, string[]> = {};
    if (dto.password !== dto.password_confirmation) {
      errors.password = ['The password field confirmation does not match.'];
    }
    if (
      await this.db.query.users.findFirst({
        where: eq(usersTable.email, dto.email),
      })
    ) {
      errors.email = ['The email has already been taken.'];
    }
    if (
      dto.phone &&
      (await this.db.query.users.findFirst({
        where: eq(usersTable.phone, dto.phone),
      }))
    ) {
      errors.phone = ['The phone has already been taken.'];
    }
    let schoolId: bigint | null = null;
    if (dto.school_code) {
      const school = await this.db.query.schools.findFirst({
        where: eq(schools.code, dto.school_code),
        orderBy: [asc(schools.id)],
      });
      if (!school)
        errors.school_code = ['The selected school code is invalid.'];
      // not in legacy: Bodhira Direct's code works like no code (below).
      else if (!school.is_direct) schoolId = school.id;
    }
    if (Object.keys(errors).length) throw new ValidationFailed(errors);

    // security: not in legacy: teacher and parent accounts wait for the school
    // to approve them (an admin sets the status to active); students are active.
    const pending = NEEDS_APPROVAL.includes(dto.role);
    // not in legacy: a student without a school code joins Bodhira Direct, the
    // default school (no seat cap; individual rules, common/direct-school.ts).
    // Teachers and parents without a code keep no school.
    if (!schoolId && dto.role === Role.Student)
      schoolId = await directSchoolId(this.db);
    const direct = !!schoolId && schoolId === (await directSchoolId(this.db));
    const now = new Date();
    const password = await hashPassword(dto.password);
    const user = await this.db.transaction(async (tx) => {
      // security: not in legacy: the school's seat caps (max_teachers / max_students)
      // apply to self-registration too. The school row is locked so two sign-ups
      // can't both take the last seat. A sign-up awaiting approval holds no seat
      // (see common/seats.ts); approving it is checked instead.
      if (schoolId && !direct && !pending && dto.role === Role.Student) {
        const [school] = await tx
          .select()
          .from(schools)
          .where(eq(schools.id, schoolId))
          .for('update');
        const max = Number(school.max_students);
        if ((await seatsUsed(tx, schoolId, Role.Student)) >= max) {
          throw ValidationFailed.field(
            'role',
            `Student limit reached (${max}). Contact your school admin to raise it.`,
          );
        }
      }
      const [row] = await tx
        .insert(usersTable)
        .values({
          school_id: schoolId,
          name: dto.name,
          email: dto.email,
          phone: dto.phone ?? null,
          password,
          role: dto.role,
          grade: dto.grade ?? null,
          status: pending ? 'on_hold' : 'active',
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row;
    });
    if (pending) {
      // No token: the account can't sign in until it is approved.
      return {
        result: {
          user: userResource(await this.withSchool(user.id)),
          token: null,
          token_type: 'Bearer',
          pending_approval: true,
        },
        message:
          'Account created. It is awaiting approval from your school; you can sign in once it is approved.',
      };
    }
    return { result: await this.session(user), message: 'Account created.' };
  }

  /** RegisterController::resolvePlan: an active individual plan by key. */
  private async resolvePlan(key: unknown) {
    if (typeof key !== 'string' || !key) return null;
    return (
      (await this.db.query.plans.findFirst({
        where: and(
          eq(plans.key, key),
          eq(plans.audience, 'individual'),
          eq(plans.is_active, true),
        ),
        orderBy: [asc(plans.id)],
      })) ?? null
    );
  }

  /** RegisterController::show: active syllabi by board, and the plan picked on /pricing. */
  async studentSignupOptions(planKey: unknown, cycleParam: unknown) {
    const rows = await this.db.query.syllabi.findMany({
      where: eq(syllabi.is_active, true),
      orderBy: [
        asc(syllabi.sort_order),
        asc(syllabi.board),
        asc(syllabi.grade),
        asc(syllabi.id),
      ],
      columns: { id: true, board: true, grade: true, name: true },
    });
    const boards = new Map<string, typeof rows>();
    for (const r of rows)
      boards.set(r.board, [...(boards.get(r.board) ?? []), r]);
    const plan = await this.resolvePlan(planKey);
    return {
      syllabi: [...boards].map(([board, syllabi]) => ({ board, syllabi })),
      plan: plan ? toModel('plans', plan) : null,
      cycle:
        cycleParam === 'monthly' || cycleParam === 'yearly'
          ? cycleParam
          : 'monthly',
    };
  }

  /**
   * RegisterController::store (B2C sign-up): a student in Bodhira Direct (not
   * in legacy: legacy had no school; same individual rules), a trial subscription (the plan's trial_days, else 7), and a session. A
   * paid plan goes on to checkout.
   */
  async registerStudent(body: unknown) {
    const data = await laravelValidate(this.db, body, {
      name: ['required', 'string', 'max:120'],
      email: ['required', 'email', 'max:160', 'unique:users,email'],
      phone: ['nullable', 'string', 'max:20', 'unique:users,phone'],
      password: ['required', 'string', 'min:6', 'confirmed'],
      syllabus_id: ['required', 'exists:syllabi,id'],
      plan_key: ['nullable', 'string', 'exists:plans,key'],
      cycle: ['nullable', 'in:monthly,yearly'],
      accept: ['accepted'],
    });

    const syllabus = await this.db.query.syllabi.findFirst({
      where: eq(syllabi.id, BigInt(String(data.syllabus_id as string))),
    });
    if (!syllabus) throw new Error('No syllabi record found');
    const plan = await this.resolvePlan(data.plan_key ?? null);
    const cycle = (data.cycle as string | null | undefined) ?? 'monthly';

    const now = new Date();
    const [user] = await this.db
      .insert(usersTable)
      .values({
        name: data.name as string,
        email: data.email as string,
        phone: (data.phone as string | null | undefined) ?? null,
        password: await hashPassword(data.password as string),
        role: Role.Student,
        school_id: await directSchoolId(this.db),
        syllabus_id: syllabus.id,
        grade: syllabus.grade,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .returning();

    const trialDays = plan?.trial_days ?? 7;
    const [sub] = await this.db
      .insert(subscriptions)
      .values({
        subscribable_type: 'App\\Models\\User',
        subscribable_id: user.id,
        plan: plan?.key ?? 'trial',
        status: 'trialing',
        trial_ends_at: new Date(now.getTime() + trialDays * 86_400_000),
        meta: phpJsonEncode({ cycle, selected_plan: plan?.key ?? null }),
        created_at: now,
        updated_at: now,
      })
      .returning();

    const paid = !!plan && (plan.monthly_price > 0 || plan.yearly_price > 0);
    return {
      result: {
        ...(await this.session(user, 'web')),
        // Paid plan → checkout for this subscription; otherwise the dashboard.
        checkout: paid ? { subscription_id: sub.id, cycle } : null,
      },
      message: `Welcome to Bodhira! Your ${trialDays}-day free trial has started.`,
    };
  }

  async login(dto: LoginDto) {
    const field = detectField(dto.identifier);
    const user = await this.db.query.users.findFirst({
      where: eq(usersTable[field], dto.identifier),
      orderBy: [asc(usersTable.id)],
    });

    // security: not in legacy: an unknown account costs the same bcrypt compare
    // as a wrong password, so response time doesn't reveal which accounts exist.
    const valid = await verifyPassword(
      dto.password,
      user ? user.password : await dummyPasswordHash(),
    );
    if (!user || !valid) {
      throw ValidationFailed.field(
        'identifier',
        'These credentials do not match our records.',
      );
    }
    if (user.status !== 'active') throw accountInactive(user.status);

    return this.loginSession(user, dto.device);
  }

  /** The tail of a successful login: stamp `last_login_at`, then the token payload. */
  async loginSession(user: users, device?: string) {
    if (user.status !== 'active') throw accountInactive(user.status);
    await this.db
      .update(usersTable)
      .set({ last_login_at: new Date() })
      .where(eq(usersTable.id, user.id));
    return this.session(user, device);
  }

  /** security: not in legacy: 503 while the OTP feature is off (no SMS provider; see OTP_LOGIN_ENABLED). */
  assertOtpEnabled() {
    if (!otpLoginEnabled()) {
      throw new ApiException(
        'Phone OTP sign-in is not available. Sign in with your email or username and password.',
        503,
        'otp_unavailable',
      );
    }
  }

  /**
   * Always answers `{ phone }` (and the code in development), whether or not the
   * phone belongs to someone, so the endpoint can't be used to find accounts.
   * security: not in legacy: unknown phones no longer get a "Guest" user row
   * (nothing for the mobile app depends on it), and admin/CMS accounts or
   * inactive ones never get a code.
   */
  async sendOtp(dto: SendOtpDto) {
    this.assertOtpEnabled();
    const otp = String(randomInt(100000, 1000000));
    // Hashed for every request, so timing doesn't tell known phones from unknown.
    const otpHash = await hashPassword(otp);
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    const now = new Date();

    const existing = await this.db.query.users.findFirst({
      where: eq(usersTable.phone, dto.phone),
      orderBy: [asc(usersTable.id)],
    });
    const payload: { phone: string | null; otp?: string } = {
      phone: dto.phone,
    };
    if (
      !existing ||
      !OTP_ROLES.includes(existing.role) ||
      existing.status !== 'active'
    ) {
      return payload;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(usersTable)
        .set({ otp: otpHash, otp_expires_at: expires, updated_at: now })
        .where(eq(usersTable.id, existing.id));
      await tx
        .insert(otp_attempts)
        .values({ user_id: existing.id, attempts: 0, updated_at: now })
        .onConflictDoUpdate({
          target: otp_attempts.user_id,
          set: { attempts: 0, updated_at: now },
        });
    });
    payload.phone = existing.phone;
    if (isDevelopment()) payload.otp = otp;
    return payload;
  }

  async verifyOtp(dto: VerifyOtpDto) {
    this.assertOtpEnabled();
    const user = await this.db.query.users.findFirst({
      where: eq(usersTable.phone, dto.phone),
      orderBy: [asc(usersTable.id)],
    });
    if (
      !user?.otp ||
      !user.otp_expires_at ||
      user.otp_expires_at.getTime() < Date.now() ||
      !OTP_ROLES.includes(user.role)
    ) {
      throw new ApiException(
        'OTP expired or not requested.',
        422,
        'otp_expired',
      );
    }
    // security: not in legacy: the attempt is counted before the code is checked
    // (so parallel guesses each use one), and the OTP dies after OTP_MAX_ATTEMPTS.
    const [row] = await this.db
      .insert(otp_attempts)
      .values({ user_id: user.id, attempts: 1, updated_at: new Date() })
      .onConflictDoUpdate({
        target: otp_attempts.user_id,
        set: {
          attempts: sql`${otp_attempts.attempts} + 1`,
          updated_at: new Date(),
        },
      })
      .returning({ attempts: otp_attempts.attempts });
    const correct =
      row.attempts <= OTP_MAX_ATTEMPTS &&
      (await verifyPassword(dto.otp, user.otp));
    if (!correct) {
      if (row.attempts >= OTP_MAX_ATTEMPTS) {
        await this.db
          .update(usersTable)
          .set({ otp: null, otp_expires_at: null })
          .where(and(eq(usersTable.id, user.id), eq(usersTable.otp, user.otp)));
        throw new ApiException(
          'Too many incorrect codes. Request a new OTP.',
          422,
          'otp_expired',
        );
      }
      throw new ApiException('Invalid OTP.', 422, 'otp_invalid');
    }
    // security: not in legacy: same gate as password login (this also stops
    // `pending` guest rows left by the old flow from activating themselves).
    if (user.status !== 'active') throw accountInactive(user.status);

    const now = new Date();
    // Single use: only the request that clears the stored code gets the session.
    const [updated] = await this.db
      .update(usersTable)
      .set({
        otp: null,
        otp_expires_at: null,
        phone_verified_at: now,
        last_login_at: now,
      })
      .where(and(eq(usersTable.id, user.id), eq(usersTable.otp, user.otp)))
      .returning();
    if (!updated) {
      throw new ApiException(
        'OTP expired or not requested.',
        422,
        'otp_expired',
      );
    }
    await this.db.delete(otp_attempts).where(eq(otp_attempts.user_id, user.id));
    return this.session(updated, dto.device);
  }

  async me(user: users) {
    return userResource(await this.withSchool(user.id));
  }
}
