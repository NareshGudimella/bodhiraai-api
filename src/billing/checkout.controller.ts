import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Response } from 'express';
import {
  CurrentUser,
  Public,
  Roles,
} from '../common/decorators/auth.decorators';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { dirtyFields, toModel } from '../common/http/eloquent';
import {
  dateString,
  forbidden,
  modelNotFound,
  phpJsonDecode,
  phpJsonEncode,
  phpRound,
  routeId,
  sameJson,
} from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import {
  invoices as invoicesTable,
  plans as plansTable,
  subscriptions as subscriptionsTable,
} from '../db/schema';
import type { subscriptions, users } from '../db/types';
import { StorageService } from '../storage/storage.service';
import {
  CYCLES,
  INDIVIDUAL_PLANS,
  TAX_RATE_BPS,
  USER_MORPH,
  periodEnd,
  pricePaiseFor,
} from './billing.constants';
import { BillingService, daysRemaining, isInTrial } from './billing.service';
import { assertDemoBilling, envString } from './gateways';
import { InvoiceService } from './invoice.service';

type Data = Record<string, unknown>;

/** `Y-m-d` date as the Date Drizzle reads back from a DATE column. */
const dateOnly = (d: Date) => new Date(`${dateString(d)}T00:00:00Z`);

/** `$request->boolean($key)`: filter_var(FILTER_VALIDATE_BOOLEAN). */
const filterBool = (v: unknown) =>
  v === true ||
  v === 1 ||
  (typeof v === 'string' &&
    ['1', 'true', 'on', 'yes'].includes(v.trim().toLowerCase()));

/**
 * New endpoints for the legacy web-only B2C billing: the public pricing data
 * (Web\PricingController), the paywall (Web\PaywallController) and checkout
 * with invoices (Web\CheckoutController).
 */
@Controller()
export class CheckoutController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly billing: BillingService,
    private readonly invoices: InvoiceService,
    private readonly storage: StorageService,
  ) {}

  /** PricingController::show: active plans by audience, in sort order. */
  @Public()
  @Get('pricing')
  async pricing() {
    const active = (audience: string) =>
      this.db.query.plans.findMany({
        where: and(
          eq(plansTable.is_active, true),
          eq(plansTable.audience, audience),
        ),
        orderBy: [asc(plansTable.sort_order), asc(plansTable.id)],
      });
    const [individual, school] = await Promise.all([
      active('individual'),
      active('school'),
    ]);
    return ok({
      individual: individual.map((p) => toModel('plans', p)),
      school: school.map((p) => toModel('plans', p)),
    });
  }

  @Roles(Role.Student)
  @Get('billing/paywall')
  async paywall(@CurrentUser() user: users) {
    const sub = await this.billing.latestSubscription(user);
    return ok({
      subscription: sub
        ? toModel('subscriptions', sub, {
            in_trial: isInTrial(sub),
            days_remaining: daysRemaining(sub),
          })
        : null,
      plans: INDIVIDUAL_PLANS,
    });
  }

  /**
   * PaywallController::checkout. In demo mode (no gateway keys) the plan is
   * activated straight away, as in legacy. Fixed legacy bug: with keys, legacy
   * also activated it without any payment. Now the choice is recorded on the
   * latest subscription (status unchanged, so no access yet) and the student
   * is sent to checkout, which activates it only after a verified payment.
   */
  @Roles(Role.Student)
  @Post('billing/paywall/checkout')
  async paywallCheckout(@CurrentUser() user: users, @Body() body: unknown) {
    const data = await laravelValidate(this.db, body, {
      plan: ['required', `in:${Object.keys(INDIVIDUAL_PLANS).join(',')}`],
      cycle: ['required', `in:${CYCLES.join(',')}`],
    });
    const key = data.plan as string;
    const cycle = data.cycle as 'monthly' | 'yearly';
    const plan = INDIVIDUAL_PLANS[key];
    const gateway = this.billing.gateway();
    const now = new Date();

    if (this.billing.liveBilling()) {
      const chosen = await this.selectPlan(user, key, cycle, now);
      return ok(
        { checkout: { subscription_id: Number(chosen.id), cycle } },
        `Complete your payment to activate ${plan.name} (${cycle}).`,
      );
    }

    // security: not in legacy: no payment is taken here, so production refuses unless BILLING_DEMO=1.
    assertDemoBilling();
    const [sub] = await this.db
      .insert(subscriptionsTable)
      .values({
        subscribable_type: USER_MORPH,
        subscribable_id: user.id,
        plan: key,
        status: 'active',
        trial_ends_at: null,
        current_period_start: dateOnly(now),
        current_period_end: dateOnly(periodEnd(cycle, now)),
        meta: phpJsonEncode({
          cycle,
          demo: !gateway.isConfigured(),
          gateway: gateway.name(),
          amount_paise: plan[cycle] * 100,
        }),
        created_at: now,
        updated_at: now,
      })
      .returning();

    let msg = `✅ ${plan.name} (${cycle}) active.`;
    if (!gateway.isConfigured()) {
      msg +=
        ' (Demo mode — set RAZORPAY_KEY_ID / STRIPE_SECRET in .env for real payments.)';
    }
    return ok(toModel('subscriptions', sub), msg);
  }

  /** CheckoutController::show: the order summary for a subscription's selected plan. */
  @Roles(Role.Student)
  @Get('billing/checkout/:subscription')
  async checkout(
    @CurrentUser() user: users,
    @Param('subscription') raw: string,
    @Query('cycle') cycleParam: unknown,
  ) {
    const sub = await this.ownSubscription(user, raw);
    const meta = phpJsonDecode(sub.meta ?? 'null') as Data | null;
    const cycle =
      typeof cycleParam === 'string' && CYCLES.includes(cycleParam)
        ? cycleParam
        : ((meta?.cycle as string | undefined) ?? 'monthly');

    const plan = await this.planFor(sub);
    if (!plan) {
      // Legacy redirects to /pricing with this error.
      throw new ApiException(
        'No plan selected — please pick one from pricing.',
        422,
        'no_plan',
      );
    }

    const amount = pricePaiseFor(plan, cycle);
    const tax = phpRound((amount * TAX_RATE_BPS) / 10000);
    const gateway = this.billing.razorpay();
    const configured = gateway.isConfigured();
    if (!configured) assertDemoBilling(); // security: not in legacy
    const orderId = configured
      ? await this.pendingOrder(sub, cycle, amount + tax)
      : null;
    return ok({
      subscription: toModel('subscriptions', sub),
      plan: toModel('plans', plan),
      cycle,
      amount_paise: amount,
      tax_paise: tax,
      total_paise: amount + tax,
      tax_rate_pct: TAX_RATE_BPS / 100,
      gateway: gateway.name(),
      demo_mode: !configured,
      // The public key the Razorpay checkout script needs (legacy prints it in the page).
      key_id: configured ? envString('RAZORPAY_KEY_ID') : null,
      // The server-side order the payment must be for (null in demo mode).
      order_id: orderId,
    });
  }

  /**
   * CheckoutController::complete: activates the subscription, then issues and
   * pays the invoice (PDF + email). Fixed legacy bug: legacy accepted any
   * Razorpay ids (or none). With Razorpay keys, the payment must now be for
   * the order checkout created (same cycle and total) and carry a valid
   * signature; each order pays once. Demo mode is unchanged.
   */
  @Roles(Role.Student)
  @Post('billing/checkout/:subscription/complete')
  @HttpCode(200)
  async complete(
    @CurrentUser() user: users,
    @Param('subscription') raw: string,
    @Body() body: unknown,
  ) {
    const sub = await this.ownSubscription(user, raw);
    const data = await laravelValidate(this.db, body, {
      cycle: ['required', `in:${CYCLES.join(',')}`],
      // Sent by the Razorpay JS handler. Optional in demo mode.
      razorpay_payment_id: ['nullable', 'string'],
      razorpay_order_id: ['nullable', 'string'],
      razorpay_signature: ['nullable', 'string'],
    });

    const plan = await this.planFor(sub);
    if (!plan) {
      throw new ApiException('No plan attached to this subscription.', 422);
    }

    const cycle = data.cycle as string;
    const input = (body && typeof body === 'object' ? body : {}) as Data;
    const now = new Date();
    const oldMeta = phpJsonDecode(sub.meta ?? 'null');
    const previous = (
      oldMeta && typeof oldMeta === 'object' ? oldMeta : {}
    ) as Data;
    const amount = pricePaiseFor(plan, cycle);
    const total = amount + phpRound((amount * TAX_RATE_BPS) / 10000);
    const verified = this.verifyPayment(previous, cycle, total, data);
    // A paid order can't be used again.
    const kept = { ...previous };
    for (const k of [
      'pending_order_id',
      'pending_cycle',
      'pending_amount_paise',
    ])
      delete kept[k];
    const meta = phpJsonEncode({
      ...(verified ? kept : previous),
      cycle,
      gateway: 'razorpay',
      razorpay_payment_id: data.razorpay_payment_id ?? null,
      razorpay_order_id: data.razorpay_order_id ?? null,
      paid_via: verified
        ? 'razorpay_handler'
        : ('demo' in input ? filterBool(input.demo) : true)
          ? 'demo'
          : 'razorpay_handler',
    });
    const changed: Data = dirtyFields(sub, {
      plan: plan.key,
      status: 'active',
      trial_ends_at: null,
      current_period_start: dateOnly(now),
      current_period_end: dateOnly(periodEnd(cycle, now)),
    });
    if (!sameJson(sub.meta, meta)) changed.meta = meta;
    if (Object.keys(changed).length) {
      await this.db
        .update(subscriptionsTable)
        .set({ ...changed, updated_at: now })
        .where(eq(subscriptionsTable.id, sub.id));
    }
    const active = { ...sub, ...changed };

    const issued = await this.invoices.issue(active, plan, cycle, user);
    const invoice = await this.invoices.markPaid(issued);
    return ok(
      toModel('invoices', invoice),
      `Payment successful · Invoice ${invoice.number} emailed.`,
    );
  }

  /** The student's own invoices, newest first. Not in legacy (it only links single invoices); used by the mobile app. */
  @Roles(Role.Student)
  @Get('billing/invoices')
  async invoiceList(@CurrentUser() user: users) {
    const rows = await this.db.query.invoices.findMany({
      where: eq(invoicesTable.user_id, user.id),
      orderBy: [desc(invoicesTable.id)],
    });
    return ok(rows.map((r) => toModel('invoices', r)));
  }

  /** CheckoutController::success: the paid invoice. */
  @Roles(Role.Student)
  @Get('billing/invoices/:invoice')
  async invoice(@CurrentUser() user: users, @Param('invoice') raw: string) {
    return ok(toModel('invoices', await this.ownInvoice(user, raw)));
  }

  /** CheckoutController::downloadInvoice. */
  @Roles(Role.Student)
  @Get('billing/invoices/:invoice/download')
  async download(
    @CurrentUser() user: users,
    @Param('invoice') raw: string,
    @Res() res: Response,
  ) {
    const invoice = await this.ownInvoice(user, raw);
    const bytes = invoice.pdf_path
      ? await this.storage.getPrivate(invoice.pdf_path)
      : null;
    if (!bytes) throw new ApiException('Invoice not generated yet.', 404);
    res
      .status(200)
      .type(
        invoice.pdf_path!.endsWith('.html') ? 'text/html' : 'application/pdf',
      )
      .attachment(`${invoice.number}.pdf`)
      .send(bytes);
  }

  /**
   * Throws unless this completion may activate the plan. Returns true for a
   * verified Razorpay payment, false in demo mode (no gateway keys at all).
   */
  private verifyPayment(
    meta: Data,
    cycle: string,
    totalPaise: number,
    data: Data,
  ) {
    const razorpay = this.billing.razorpay();
    if (!razorpay.isConfigured()) {
      if (this.billing.liveBilling()) {
        throw new ApiException(
          'Online payment is not available right now.',
          422,
          'payment_unavailable',
        );
      }
      // security: not in legacy: demo completion (no payment) needs BILLING_DEMO=1 in production.
      assertDemoBilling();
      return false;
    }
    const orderId = data.razorpay_order_id;
    const paymentId = data.razorpay_payment_id;
    const signature = data.razorpay_signature;
    const ok =
      typeof orderId === 'string' &&
      typeof paymentId === 'string' &&
      typeof signature === 'string' &&
      orderId === meta.pending_order_id &&
      cycle === meta.pending_cycle &&
      totalPaise === meta.pending_amount_paise &&
      razorpay.verifyPaymentSignature(orderId, paymentId, signature);
    if (!ok) {
      throw new ApiException(
        'Payment could not be verified.',
        422,
        'payment_unverified',
      );
    }
    return true;
  }

  /**
   * The Razorpay order for this checkout, created server-side so the amount
   * can't be changed in the browser. Reused while the cycle and total match.
   */
  private async pendingOrder(
    sub: subscriptions,
    cycle: string,
    totalPaise: number,
  ) {
    const decoded = phpJsonDecode(sub.meta ?? 'null');
    const meta = (
      decoded && typeof decoded === 'object' ? decoded : {}
    ) as Data;
    if (
      typeof meta.pending_order_id === 'string' &&
      meta.pending_cycle === cycle &&
      meta.pending_amount_paise === totalPaise
    ) {
      return meta.pending_order_id;
    }
    const order = await this.billing
      .razorpay()
      .createOrder(totalPaise, `bdh-sub-${sub.id}`, {
        subscription_id: String(sub.id),
        cycle,
      });
    await this.db
      .update(subscriptionsTable)
      .set({
        meta: phpJsonEncode({
          ...meta,
          pending_order_id: order.id,
          pending_cycle: cycle,
          pending_amount_paise: totalPaise,
        }),
        updated_at: new Date(),
      })
      .where(eq(subscriptionsTable.id, sub.id));
    return order.id;
  }

  /**
   * Paywall choice with live billing: remember the plan on the latest
   * subscription for checkout (as sign-up does), without granting access.
   * A student with no subscription gets an `incomplete` one.
   */
  private async selectPlan(user: users, key: string, cycle: string, now: Date) {
    const latest = await this.billing.latestSubscription(user);
    if (!latest) {
      const [created] = await this.db
        .insert(subscriptionsTable)
        .values({
          subscribable_type: USER_MORPH,
          subscribable_id: user.id,
          plan: key,
          status: 'incomplete',
          trial_ends_at: null,
          meta: phpJsonEncode({ cycle, selected_plan: key }),
          created_at: now,
          updated_at: now,
        })
        .returning();
      return created;
    }
    const decoded = phpJsonDecode(latest.meta ?? 'null');
    const meta = phpJsonEncode({
      ...(decoded && typeof decoded === 'object' ? decoded : {}),
      cycle,
      selected_plan: key,
    });
    if (!sameJson(latest.meta, meta)) {
      await this.db
        .update(subscriptionsTable)
        .set({ meta, updated_at: now })
        .where(eq(subscriptionsTable.id, latest.id));
    }
    return latest;
  }

  /** Route binding plus CheckoutController::guard (403 unless it's the user's own). */
  private async ownSubscription(user: users, raw: string) {
    const id = routeId(raw, 'Subscription');
    const sub = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptionsTable.id, id),
    });
    if (!sub) throw modelNotFound('Subscription', id);
    if (
      sub.subscribable_type !== USER_MORPH ||
      sub.subscribable_id !== user.id
    ) {
      throw new ApiException('Not your subscription.', 403);
    }
    return sub;
  }

  /** Route binding plus guardInvoice (an invoice without a user is open to any student). */
  private async ownInvoice(user: users, raw: string) {
    const id = routeId(raw, 'Invoice');
    const invoice = await this.db.query.invoices.findFirst({
      where: eq(invoicesTable.id, id),
    });
    if (!invoice) throw modelNotFound('Invoice', id);
    if (invoice.user_id && invoice.user_id !== user.id) throw forbidden();
    return invoice;
  }

  /** CheckoutController::planFor: the selected (or current) plan; none for trials. */
  private async planFor(sub: subscriptions) {
    const meta = phpJsonDecode(sub.meta ?? 'null') as Data | null;
    const key = (meta?.selected_plan as string | null | undefined) ?? sub.plan;
    if (!key || key === 'trial') return null;
    return (
      (await this.db.query.plans.findFirst({
        where: eq(plansTable.key, String(key)),
        orderBy: [asc(plansTable.id)],
      })) ?? null
    );
  }
}
