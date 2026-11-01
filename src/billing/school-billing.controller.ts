import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ApiException, ValidationFailed } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { dirtyFields, toModel } from '../common/http/eloquent';
import {
  dateString,
  modelNotFound,
  phpJsonEncode,
  routeId,
} from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { pageFrom, pageMeta } from '../common/http/paginate';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { assertNotDirect } from '../common/direct-school';
import { myDesc } from '../db/helpers';
import {
  payments as paymentsTable,
  schools as schoolsTable,
  users as usersTable,
} from '../db/schema';
import type { users } from '../db/types';
import { PLAN_PRICING } from './billing.constants';
import { BillingService } from './billing.service';

const PLANS = `in:${Object.keys(PLAN_PRICING).join(',')}`;
const today = () => new Date(`${dateString(new Date())}T00:00:00Z`);

/**
 * New endpoints for the legacy web-only school billing (Web\BillingController):
 * the school admin's plan page and gateway checkout, and the super admin's
 * payment list and manual grants.
 */
@Controller()
export class SchoolBillingController {
  private readonly logger = new Logger('Billing');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly billing: BillingService,
  ) {}

  /** `$user->school` (soft-deleted schools count as none). */
  private async school(user: users) {
    return user.school_id ? this.liveSchool(user.school_id) : null;
  }

  /** A school that isn't soft-deleted, or null. */
  private async liveSchool(id: bigint) {
    return (
      (await this.db.query.schools.findFirst({
        where: and(eq(schoolsTable.id, id), isNull(schoolsTable.deleted_at)),
        orderBy: [asc(schoolsTable.id)],
      })) ?? null
    );
  }

  /** BillingController::adminIndex. */
  @Roles(Role.Admin)
  @Get('admin/billing')
  async adminIndex(@CurrentUser() user: users) {
    const school = await this.school(user);
    const [payments, studentsUsed] = school
      ? await Promise.all([
          this.db.query.payments.findMany({
            where: eq(paymentsTable.school_id, school.id),
            orderBy: [myDesc(paymentsTable.created_at), asc(paymentsTable.id)],
            limit: 20,
          }),
          this.db.$count(
            usersTable,
            and(
              eq(usersTable.school_id, school.id),
              eq(usersTable.role, 'student'),
            ),
          ),
        ])
      : [[], 0];
    const gateway = this.billing.gateway();
    return ok({
      school: school ? toModel('schools', school) : null,
      payments: payments.map((p) => toModel('payments', p)),
      pricing: PLAN_PRICING,
      gateway: gateway.name(),
      configured: gateway.isConfigured(),
      students_used: studentsUsed,
    });
  }

  /**
   * BillingController::adminCheckout: the free plan switches at once; paid
   * plans create a pending payment and the gateway order. Legacy redirects
   * back with the errors below; the API returns them as a 422.
   */
  @Roles(Role.Admin)
  @Post('admin/billing/checkout')
  async adminCheckout(@CurrentUser() user: users, @Body() body: unknown) {
    const data = await laravelValidate(this.db, body, {
      plan: ['required', PLANS],
      gateway: ['nullable', 'in:razorpay,stripe'],
    });
    const school = await this.school(user);
    if (!school) {
      throw ValidationFailed.field(
        'plan',
        'Your account is not linked to a school.',
      );
    }
    assertNotDirect(school, 'be billed as a school'); // not in legacy

    const plan = data.plan as string;
    const amount = this.billing.priceForPlan(plan);
    if (amount === 0) {
      const changed = dirtyFields(school, { plan: 'free' });
      if (Object.keys(changed).length) {
        await this.db
          .update(schoolsTable)
          .set({ ...changed, updated_at: new Date() })
          .where(eq(schoolsTable.id, school.id));
      }
      return ok({ plan: 'free' }, 'Switched to Free plan.');
    }

    const gateway = this.billing.gateway(
      (data.gateway as string | null) ?? null,
    );
    try {
      return ok(await gateway.createCheckout(school, plan, amount));
    } catch (e) {
      // security: not in legacy: the gateway's error (raw response bodies, config
      // names) is logged, not returned.
      if (e instanceof ApiException) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Checkout failed: ${msg}`);
      throw ValidationFailed.field(
        'plan',
        'Checkout failed: the payment gateway is unavailable. Try again later.',
      );
    }
  }

  /** BillingController::superIndex: every payment, newest first, 30 a page. */
  @Roles(Role.SuperAdmin)
  @Get('super/billing')
  async superIndex(@Query('page') rawPage: unknown) {
    const page = pageFrom(rawPage);
    const [total, rows] = await Promise.all([
      this.db.$count(paymentsTable),
      this.db.query.payments.findMany({
        orderBy: [myDesc(paymentsTable.created_at), asc(paymentsTable.id)],
        offset: (page - 1) * 30,
        limit: 30,
        with: { schools: true },
      }),
    ]);
    return ok(
      rows.map(({ schools: school, ...p }) =>
        toModel('payments', p, {
          school:
            school && !school.deleted_at ? toModel('schools', school) : null,
        }),
      ),
      null,
      pageMeta(page, 30, total),
    );
  }

  /** BillingController::manualGrant: mark a school as paid (wire transfer, comp plan). */
  @Roles(Role.SuperAdmin)
  @Post('super/billing/schools/:school/grant')
  async manualGrant(
    @CurrentUser() user: users,
    @Param('school') raw: string,
    @Body() body: unknown,
  ) {
    const id = routeId(raw, 'School');
    const school = await this.liveSchool(id);
    if (!school) throw modelNotFound('School', id);
    assertNotDirect(school, 'be billed as a school'); // not in legacy

    const data = await laravelValidate(this.db, body, {
      plan: ['required', PLANS],
      days: ['required', 'integer', 'min:1', 'max:730'],
      amount_paise: ['required', 'integer', 'min:0'],
      note: ['nullable', 'string', 'max:255'],
    });
    const plan = data.plan as string;
    const start = today();
    const end = today();
    end.setUTCDate(end.getUTCDate() + Math.trunc(Number(data.days)));
    const now = new Date();

    await this.db.insert(paymentsTable).values({
      school_id: school.id,
      gateway: 'manual',
      plan,
      amount_paise: BigInt(Math.trunc(Number(data.amount_paise))),
      currency: 'INR',
      status: 'paid',
      period_start: start,
      period_end: end,
      meta: phpJsonEncode({
        note: data.note ?? null,
        granted_by: Number(user.id),
      }),
      created_at: now,
      updated_at: now,
    });

    const changed = dirtyFields(school, {
      plan,
      plan_expires_at: end,
      status: 'active',
    });
    if (Object.keys(changed).length) {
      await this.db
        .update(schoolsTable)
        .set({ ...changed, updated_at: now })
        .where(eq(schoolsTable.id, school.id));
    }
    return ok(
      null,
      `Granted ${school.name} → ${plan} for ${String(data.days as string | number)} days.`,
    );
  }
}
