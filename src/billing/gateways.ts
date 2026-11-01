import { createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { ApiException } from '../common/http/api.exception';
import { dirtyFields } from '../common/http/eloquent';
import {
  dateString,
  phpJsonDecode,
  phpJsonEncode,
  sameJson,
} from '../common/http/laravel';
import type { Db } from '../db/db';
import {
  payments as paymentsTable,
  schools as schoolsTable,
} from '../db/schema';
import type { payments, schools } from '../db/types';
import { strRandom } from '../storage/laravel-str';

type Event = Record<string, unknown>;

/**
 * Laravel env() as a string, like the legacy `(string) env('X')`: unset is '',
 * and the literals true/false/empty/null map to '1' / '' / '' / ''.
 */
export function envString(name: string): string {
  const raw = process.env[name];
  if (raw === undefined) return '';
  const literal = raw.toLowerCase().replace(/^\((.*)\)$/, '$1');
  if (literal === 'true') return '1';
  if (['false', 'empty', 'null'].includes(literal)) return '';
  return raw;
}

/**
 * security: not in legacy. Demo billing (plans activate with no payment when
 * no gateway keys are set) is off in production unless BILLING_DEMO=1.
 */
export const demoBillingAllowed = () =>
  process.env.NODE_ENV !== 'production' || process.env.BILLING_DEMO === '1';

/** 503 when a request would need demo billing and it isn't allowed. */
export function assertDemoBilling() {
  if (!demoBillingAllowed()) {
    throw new ApiException(
      'Online payment is not available right now.',
      503,
      'payment_unavailable',
    );
  }
}

/** `$a[k1][k2]…` with PHP's `??` semantics: null when any step is missing. */
export function dig(value: unknown, ...path: string[]): unknown {
  let v = value;
  for (const k of path) {
    if (!v || typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[k];
    if (v === undefined) return null;
  }
  return v;
}

/** hash_equals(): constant-time, and false for different lengths. */
function hashEquals(known: string, user: string) {
  const a = Buffer.from(known);
  const b = Buffer.from(user);
  return a.length === b.length && timingSafeEqual(a, b);
}

const hmac = (data: string, secret: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

/** A decoded JSON scalar as the string legacy stored for it (non-scalars as JSON). */
const scalarString = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : JSON.stringify(v);

/** PHP falsiness (`! $v`, `empty($v)`). */
const falsy = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === false ||
  v === 0 ||
  v === '' ||
  v === '0' ||
  (Array.isArray(v) && !v.length);

/** `json_decode($payload, true) ?: []`. */
function decodeOrEmpty(payload: string): unknown {
  const v = phpJsonDecode(payload);
  return falsy(v) ? [] : v;
}

export interface CheckoutPayload {
  gateway: string;
  demo?: true;
  key_id?: string;
  payment_id: bigint;
  order_id?: string;
  session_id?: string;
  checkout_url?: string | null;
  amount_paise: number;
  currency: string;
}

const today = () => new Date(`${dateString(new Date())}T00:00:00Z`);
const daysFromToday = (days: number) => {
  const d = today();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

/** Payment rows and the school plan they pay for (shared by both gateways). */
abstract class Gateway {
  protected readonly logger = new Logger('Billing');

  constructor(protected readonly db: Db) {}

  abstract name(): string;
  abstract isConfigured(): boolean;
  abstract verifyWebhook(payload: string, signature: string): Event;
  abstract applyEvent(event: Event): Promise<payments | null>;

  /** Payment::create([... 'status' => 'pending']). */
  protected async pendingPayment(
    school: schools,
    plan: string,
    amountPaise: number,
    currency: string,
  ) {
    const now = new Date();
    const [row] = await this.db
      .insert(paymentsTable)
      .values({
        school_id: school.id,
        gateway: this.name(),
        plan,
        amount_paise: BigInt(amountPaise),
        currency,
        status: 'pending',
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /** `$payment->gateway_order_id = $id; $payment->save();` */
  protected async setOrderId(payment: payments, orderId: string) {
    const changed = dirtyFields(payment, { gateway_order_id: orderId });
    if (!Object.keys(changed).length) return;
    await this.db
      .update(paymentsTable)
      .set({ ...changed, updated_at: new Date() })
      .where(eq(paymentsTable.id, payment.id));
  }

  /**
   * The paid branch of applyEvent: the payment covers the next 30 days and the
   * school moves to its plan. Both saves write only changed columns.
   */
  protected async markPaid(
    payment: payments,
    gatewayPaymentId: unknown,
    event: Event,
  ) {
    const fields = {
      gateway_payment_id:
        gatewayPaymentId === null ? null : scalarString(gatewayPaymentId),
      status: 'paid',
      period_start: today(),
      period_end: daysFromToday(30),
    };
    const meta = phpJsonEncode(event);
    const changed: Record<string, unknown> = dirtyFields(payment, fields);
    if (!sameJson(payment.meta, meta)) changed.meta = meta;
    const now = new Date();
    // security: not in legacy: a payment is applied once. The pending → paid
    // switch is one conditional UPDATE, so a re-sent `payment.captured`, the
    // `order.paid` that follows it, or two parallel deliveries can't extend
    // the school's plan again.
    if (payment.status === 'paid') return payment;
    const [claimed] = await this.db
      .update(paymentsTable)
      .set({ ...changed, status: 'paid', updated_at: now })
      .where(
        and(eq(paymentsTable.id, payment.id), ne(paymentsTable.status, 'paid')),
      )
      .returning({ id: paymentsTable.id });
    if (!claimed) {
      this.logger.log(`Payment ${payment.id} already applied; event ignored`);
      return payment;
    }
    await this.activateSchool(
      payment.school_id,
      payment.plan,
      fields.period_end,
    );
    const fresh = await this.db.query.payments.findFirst({
      where: eq(paymentsTable.id, payment.id),
    });
    if (!fresh) throw new Error('No payments found');
    return fresh;
  }

  /** `$payment->school?->update([...])` (soft-deleted schools are skipped). */
  protected async activateSchool(
    schoolId: bigint,
    plan: string,
    expires: Date,
  ) {
    const school = await this.db.query.schools.findFirst({
      where: and(
        eq(schoolsTable.id, schoolId),
        isNull(schoolsTable.deleted_at),
      ),
      orderBy: [asc(schoolsTable.id)],
    });
    if (!school) return;
    const changed = dirtyFields(school, {
      plan,
      plan_expires_at: expires,
      status: 'active',
    });
    if (!Object.keys(changed).length) return;
    await this.db
      .update(schoolsTable)
      .set({ ...changed, updated_at: new Date() })
      .where(eq(schoolsTable.id, school.id));
  }

  protected async byOrderId(orderId: unknown) {
    return (
      (await this.db.query.payments.findFirst({
        where: eq(paymentsTable.gateway_order_id, scalarString(orderId)),
        orderBy: [asc(paymentsTable.id)],
      })) ?? null
    );
  }
}

export class RazorpayGateway extends Gateway {
  name() {
    return 'razorpay';
  }

  isConfigured() {
    return (
      envString('RAZORPAY_KEY_ID') !== '' &&
      envString('RAZORPAY_KEY_SECRET') !== ''
    );
  }

  async createCheckout(
    school: schools,
    plan: string,
    amountPaise: number,
    currency = 'INR',
  ): Promise<CheckoutPayload> {
    if (!this.isConfigured()) assertDemoBilling();
    const payment = await this.pendingPayment(
      school,
      plan,
      amountPaise,
      currency,
    );

    if (!this.isConfigured()) {
      // Demo mode — no real order created
      const orderId = `demo_${strRandom(12)}`;
      await this.setOrderId(payment, orderId);
      return {
        gateway: 'razorpay',
        demo: true,
        payment_id: payment.id,
        order_id: orderId,
        amount_paise: amountPaise,
        currency,
      };
    }

    const keyId = envString('RAZORPAY_KEY_ID');
    const order = await this.createOrder(
      amountPaise,
      `bdh-${payment.id}`,
      {
        school_id: String(school.id),
        plan,
        payment_id: String(payment.id),
      },
      currency,
    );
    await this.setOrderId(payment, order.id);
    return {
      gateway: 'razorpay',
      key_id: keyId,
      payment_id: payment.id,
      order_id: order.id,
      amount_paise: amountPaise,
      currency,
    };
  }

  /** POST /v1/orders: the amount is fixed here, on the server. */
  async createOrder(
    amountPaise: number,
    receipt: string,
    notes: Record<string, string>,
    currency = 'INR',
  ) {
    const auth = Buffer.from(
      `${envString('RAZORPAY_KEY_ID')}:${envString('RAZORPAY_KEY_SECRET')}`,
    ).toString('base64');
    const resp = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ amount: amountPaise, currency, receipt, notes }),
    });
    const body = await resp.text();
    if (!resp.ok) {
      throw new Error(`Razorpay order create failed: ${body}`);
    }
    return JSON.parse(body) as { id: string };
  }

  /**
   * The Checkout handler's signature: HMAC-SHA256 of `order_id|payment_id`
   * with the key secret. Only Razorpay can produce it for a paid order.
   */
  verifyPaymentSignature(
    orderId: string,
    paymentId: string,
    signature: string,
  ) {
    const secret = envString('RAZORPAY_KEY_SECRET');
    return (
      secret !== '' &&
      hashEquals(hmac(`${orderId}|${paymentId}`, secret), signature)
    );
  }

  verifyWebhook(payload: string, signature: string): Event {
    const secret = envString('RAZORPAY_WEBHOOK_SECRET');
    if (secret === '') {
      throw new Error('RAZORPAY_WEBHOOK_SECRET not set');
    }
    if (!hashEquals(hmac(payload, secret), signature)) {
      throw new Error('Invalid Razorpay signature');
    }
    const event = decodeOrEmpty(payload);
    if (falsy(dig(event, 'event'))) {
      throw new Error('Malformed Razorpay event');
    }
    return event as Event;
  }

  async applyEvent(event: Event) {
    const type = event.event;
    const payload = event.payload ?? [];

    if (type === 'payment.captured' || type === 'order.paid') {
      const orderId =
        dig(payload, 'payment', 'entity', 'order_id') ??
        dig(payload, 'order', 'entity', 'id');
      if (falsy(orderId)) return null;

      const payment = await this.byOrderId(orderId);
      if (!payment) return null;
      return this.markPaid(
        payment,
        dig(payload, 'payment', 'entity', 'id'),
        event,
      );
    }

    if (type === 'payment.failed') {
      const orderId = dig(payload, 'payment', 'entity', 'order_id');
      if (falsy(orderId)) return null;
      const payment = await this.byOrderId(orderId);
      if (!payment) return null;
      // security: not in legacy: a late or replayed failure can't undo a paid payment.
      if (payment.status === 'paid') return payment;
      const meta = phpJsonEncode(event);
      const changed: Record<string, unknown> = dirtyFields(payment, {
        status: 'failed',
      });
      if (!sameJson(payment.meta, meta)) changed.meta = meta;
      if (Object.keys(changed).length) {
        await this.db
          .update(paymentsTable)
          .set({ ...changed, updated_at: new Date() })
          .where(eq(paymentsTable.id, payment.id));
      }
      return payment;
    }

    return null;
  }
}

export class StripeGateway extends Gateway {
  name() {
    return 'stripe';
  }

  isConfigured() {
    return envString('STRIPE_SECRET') !== '';
  }

  async createCheckout(
    school: schools,
    plan: string,
    amountPaise: number,
    currency = 'INR',
  ): Promise<CheckoutPayload> {
    if (!this.isConfigured()) assertDemoBilling();
    const payment = await this.pendingPayment(
      school,
      plan,
      amountPaise,
      currency,
    );

    if (!this.isConfigured()) {
      const sessionId = `demo_${strRandom(12)}`;
      await this.setOrderId(payment, sessionId);
      return {
        gateway: 'stripe',
        demo: true,
        payment_id: payment.id,
        session_id: sessionId,
        amount_paise: amountPaise,
        currency,
      };
    }

    // route('billing.success') / route('billing.cancel') live on the web app.
    const web = (process.env.WEB_URL ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    );
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price_data][currency]': currency.toLowerCase(),
      'line_items[0][price_data][product_data][name]': `Bodhira ${plan} plan`,
      'line_items[0][price_data][unit_amount]': String(amountPaise),
      'line_items[0][quantity]': '1',
      success_url: `${web}/billing/success?payment_id=${payment.id}`,
      cancel_url: `${web}/billing/cancel?payment_id=${payment.id}`,
      'metadata[school_id]': String(school.id),
      'metadata[plan]': plan,
      'metadata[payment_id]': String(payment.id),
    });
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${envString('STRIPE_SECRET')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
    });
    const body = await resp.text();
    if (!resp.ok) {
      throw new Error(`Stripe session create failed: ${body}`);
    }
    const session = JSON.parse(body) as { id: string; url?: string };
    await this.setOrderId(payment, session.id);
    return {
      gateway: 'stripe',
      payment_id: payment.id,
      session_id: session.id,
      checkout_url: session.url ?? null,
      amount_paise: amountPaise,
      currency,
    };
  }

  verifyWebhook(payload: string, signature: string): Event {
    const secret = envString('STRIPE_WEBHOOK_SECRET');
    if (secret === '') {
      throw new Error('STRIPE_WEBHOOK_SECRET not set');
    }
    // Stripe signature format: t=...,v1=...
    const parts: Record<string, string> = {};
    for (const kv of signature.split(',')) {
      const trimmed = kv.trim();
      const at = trimmed.indexOf('=');
      const [k, v] =
        at < 0 ? [trimmed, ''] : [trimmed.slice(0, at), trimmed.slice(at + 1)];
      // PHP truthiness: '' and '0' don't count.
      if (k && k !== '0' && v && v !== '0') parts[k] = v;
    }
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1) {
      throw new Error('Malformed Stripe-Signature');
    }
    if (Math.abs(Math.floor(Date.now() / 1000) - phpIntval(timestamp)) > 300) {
      throw new Error('Stripe webhook timestamp drift');
    }
    if (!hashEquals(hmac(`${timestamp}.${payload}`, secret), v1)) {
      throw new Error('Invalid Stripe signature');
    }
    return decodeOrEmpty(payload) as Event;
  }

  async applyEvent(event: Event) {
    const obj = dig(event, 'data', 'object') ?? [];
    const sessionId = dig(obj, 'id');
    if (falsy(sessionId)) return null;

    if (dig(event, 'type') === 'checkout.session.completed') {
      const payment = await this.byOrderId(sessionId);
      if (!payment) return null;
      return this.markPaid(payment, dig(obj, 'payment_intent'), event);
    }

    return null;
  }
}

/** PHP (int) on a numeric-prefix string: "123abc" → 123, "abc" → 0. */
function phpIntval(s: string) {
  const m = /^\s*[+-]?\d+/.exec(s);
  return m ? Number(m[0]) : 0;
}

export type BillingGateway = RazorpayGateway | StripeGateway;
