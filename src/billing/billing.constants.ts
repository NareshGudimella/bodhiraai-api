import type { plans } from '../db/types';

export { PLAN_PRICING } from '../super/super.service';

/** Morph class of App\Models\User in `subscribable_type`. */
export const USER_MORPH = 'App\\Models\\User';

/** InvoiceService::TAX_RATE_BPS: GST in basis points (1800 = 18.00 %). */
export const TAX_RATE_BPS = 1800;

export const CYCLES = ['monthly', 'yearly'];

/** SuperAdminService::INDIVIDUAL_PLANS: the paywall's B2C plans (₹ per cycle). */
export const INDIVIDUAL_PLANS: Record<
  string,
  {
    name: string;
    tagline: string;
    features: string[];
    monthly: number;
    yearly: number;
  }
> = {
  individual_basic: {
    name: 'Individual Basic',
    tagline: 'Full syllabus access',
    features: [
      'All chapters & lessons',
      'Quizzes & progress tracking',
      'Email support',
    ],
    monthly: 299,
    yearly: 2499,
  },
  individual_premium: {
    name: 'Individual Premium',
    tagline: 'Everything, plus the AI tutor',
    features: [
      'Everything in Basic',
      'AI doubt solver (unlimited)',
      'Downloadable PDFs',
      'Priority support',
    ],
    monthly: 599,
    yearly: 4999,
  },
};

/** Plan::pricePaiseFor($cycle). */
export const pricePaiseFor = (plan: plans, cycle: string) =>
  (cycle === 'yearly' ? plan.yearly_price : plan.monthly_price) * 100;

/** Carbon now()->addMonth() / addYear() (end-of-month overflow, like JS Date). */
export function periodEnd(cycle: string, from = new Date()) {
  const d = new Date(from);
  if (cycle === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
