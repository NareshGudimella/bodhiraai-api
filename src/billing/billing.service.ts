import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { subscriptions as subscriptionsTable } from '../db/schema';
import type { subscriptions, users } from '../db/types';
import { PLAN_PRICING } from './billing.constants';
import {
  envString,
  RazorpayGateway,
  StripeGateway,
  type BillingGateway,
} from './gateways';
import { USER_MORPH } from './billing.constants';

/** Port of App\Services\Billing\BillingManager, plus the subscription lookups the billing controllers share. */
@Injectable()
export class BillingService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** BILLING_GATEWAY (default razorpay) unless a name is given. */
  gateway(name?: string | null): BillingGateway {
    const chosen = name ?? (envString('BILLING_GATEWAY') || 'razorpay');
    switch (chosen.toLowerCase()) {
      case 'razorpay':
        return new RazorpayGateway(this.db);
      case 'stripe':
        return new StripeGateway(this.db);
      default:
        throw new Error(`Unknown billing gateway: ${chosen}`);
    }
  }

  /** The B2C checkout's gateway (legacy CheckoutController always uses Razorpay). */
  razorpay() {
    return new RazorpayGateway(this.db);
  }

  /** Real money is in play: the default gateway or Razorpay has keys. */
  liveBilling() {
    return this.gateway().isConfigured() || this.razorpay().isConfigured();
  }

  /** School plan price in paise (PLAN_PRICING is rupees per month). */
  priceForPlan(plan: string) {
    return (PLAN_PRICING[plan] ?? 0) * 100;
  }

  /** `$user->subscription()->latest()->first()` (latestOfMany: highest id). */
  async latestSubscription(user: users) {
    return (
      (await this.db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptionsTable.subscribable_type, USER_MORPH),
          eq(subscriptionsTable.subscribable_id, user.id),
        ),
        orderBy: [desc(subscriptionsTable.id)],
      })) ?? null
    );
  }
}

/** Subscription::isInTrial(). */
export const isInTrial = (s: subscriptions) =>
  s.status === 'trialing' &&
  !!s.trial_ends_at &&
  s.trial_ends_at.getTime() > Date.now();

/** Subscription::daysRemaining(): whole days left (Carbon 3 diffInDays, truncated). */
export function daysRemaining(s: subscriptions) {
  const end = isInTrial(s) ? s.trial_ends_at : s.current_period_end;
  if (!end) return 0;
  return Math.trunc(Math.max(0, (end.getTime() - Date.now()) / 86_400_000));
}
