import {
  applyDecorators,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { AuthedRequest } from './auth.decorators';

/** What a limit is counted per (Laravel `Limit::...->by(...)`). */
export type RateKey = 'ip' | 'user' | 'phone';

const RATE_KEY = 'rateKey';

/** Legacy limiter values per minute (AppServiceProvider::boot). */
export const LIMITS = { auth: 8, otp: 3, ai: 20, webhooks: 60 } as const;

/** ThrottlerGuard keyed like the legacy RateLimiter definitions. */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected async shouldSkip(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ rateKey?: RateKey }>();
    req.rateKey =
      this.reflector.get<RateKey>(RATE_KEY, ctx.getHandler()) ?? 'ip';
    return super.shouldSkip(ctx);
  }

  protected getTracker(req: Record<string, any>): Promise<string> {
    const r = req as {
      user?: AuthedRequest['user'];
      ip?: string;
      body?: { phone?: unknown };
      rateKey?: RateKey;
    };
    if (r.rateKey === 'user' && r.user)
      return Promise.resolve(`u:${r.user.id}`);
    if (r.rateKey === 'phone' && typeof r.body?.phone === 'string') {
      return Promise.resolve(`p:${r.body.phone}`);
    }
    return Promise.resolve(`ip:${r.ip}`);
  }
}

/**
 * Laravel `throttle:<name>` on a route: `limit` requests per minute, counted per `key`.
 * Routes without it are not rate-limited (the legacy app attaches no global limiter).
 */
export const RateLimit = (
  limit: number,
  key: RateKey = 'ip',
  /** security: not in legacy: window in ms (default one minute). */
  ttlMs = 60_000,
) =>
  applyDecorators(
    SetMetadata(RATE_KEY, key),
    UseGuards(RateLimitGuard),
    Throttle({ default: { limit, ttl: ttlMs } }),
  );
