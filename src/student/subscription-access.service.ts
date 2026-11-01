import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { users } from '../db/types';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { schools, subscriptions } from '../db/schema';
import { schoolOf } from '../common/direct-school';

const USER_MORPH = 'App\\Models\\User';

/**
 * Port of App\Http\Middleware\EnsureActiveSubscription::hasAccess().
 *  - Non-students are never gated.
 *  - B2B students (school_id): the school's status, plan and plan_expires_at.
 *  - B2C students: their latest Subscription row (trialing → trial_ends_at, active → current_period_end).
 *    Bodhira Direct students count as B2C (not in legacy: common/direct-school.ts).
 */
@Injectable()
export class SubscriptionAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async hasAccess(user: users): Promise<boolean> {
    if (user.role !== (Role.Student as string)) return true;
    const now = Date.now();

    const schoolId = await schoolOf(this.db, user);
    if (schoolId) {
      const school = await this.db.query.schools.findFirst({
        where: eq(schools.id, schoolId),
      });
      if (!school || school.status !== 'active') return false;
      if (school.plan === 'free' || !school.plan_expires_at) return true;
      return school.plan_expires_at.getTime() > now;
    }

    const sub = await this.db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.subscribable_type, USER_MORPH),
        eq(subscriptions.subscribable_id, user.id),
      ),
      orderBy: [desc(subscriptions.id)],
    });
    if (!sub) return false;
    if (sub.status === 'trialing')
      return !!sub.trial_ends_at && sub.trial_ends_at.getTime() > now;
    if (sub.status === 'active') {
      return !!sub.current_period_end && sub.current_period_end.getTime() > now;
    }
    return false;
  }
}
