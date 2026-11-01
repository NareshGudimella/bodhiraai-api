import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The caller as Laravel's Request sees it: ip(), userAgent(), the Referer header. */
export interface ClientInfo {
  ip: string | null;
  userAgent: string;
  referer: string | null;
}

/**
 * `$request->ip()` and friends. The web app calls the API from its server, so
 * it forwards the visitor's address in X-Forwarded-For; Express honours that
 * only from proxies listed in TRUST_PROXY (app.setup.ts).
 */
export const Client = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ClientInfo => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return {
      // An IPv4 caller on a dual-stack socket shows as ::ffff:a.b.c.d; PHP sees a.b.c.d.
      ip: req.ip?.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '') ?? null,
      userAgent: req.headers['user-agent'] ?? '',
      referer: req.headers.referer ?? null,
    };
  },
);
