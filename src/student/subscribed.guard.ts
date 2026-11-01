import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthedRequest } from '../common/decorators/auth.decorators';
import { ApiException } from '../common/http/api.exception';
import { SubscriptionAccessService } from './subscription-access.service';

/** Same body as the legacy `EnsureActiveSubscription` API response. */
export const SUBSCRIPTION_INACTIVE_MESSAGE =
  'Your subscription is not active. Please complete checkout to continue.';

/**
 * security: not in legacy API (the legacy web enforced it with the `subscribed`
 * middleware; the API never did). Gate for student learning routes: when
 * `SubscriptionAccessService.hasAccess()` is false, answer 402 with
 * `{ success:false, message, code:'subscription_inactive' }`, exactly what
 * the legacy middleware returned for JSON requests. Non-students pass.
 * Runs after the global TokenAuthGuard/RolesGuard, so `req.user` is set.
 */
@Injectable()
export class SubscribedGuard implements CanActivate {
  constructor(private readonly access: SubscriptionAccessService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const { user } = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!user) return true; // the auth guards decide for anonymous callers
    if (await this.access.hasAccess(user)) return true;
    throw new ApiException(
      SUBSCRIPTION_INACTIVE_MESSAGE,
      402,
      'subscription_inactive',
    );
  }
}
