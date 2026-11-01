import { Controller, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/auth.decorators';
import { LIMITS, RateLimit } from '../common/decorators/rate-limit';
import { BillingService } from './billing.service';

/** Webhook rejections that are about the request itself (safe to tell the sender). */
const CLIENT_SAFE =
  /^(Invalid (Razorpay|Stripe) signature|Malformed (Razorpay event|Stripe-Signature)|Stripe webhook timestamp drift)$/;

/**
 * Port of App\Http\Controllers\WebhookController. Same URLs as legacy
 * (`/webhooks/{razorpay,stripe}`, outside /api/v1) and the same bare JSON
 * replies. The body arrives as raw bytes (app.setup.ts) so the HMAC covers
 * the exact payload.
 */
@Controller('webhooks')
@Public()
export class WebhookController {
  private readonly logger = new Logger('Webhooks');

  constructor(private readonly billing: BillingService) {}

  @Post('razorpay')
  @RateLimit(LIMITS.webhooks)
  razorpay(@Req() req: Request, @Res() res: Response) {
    return this.handle(
      'razorpay',
      'Razorpay',
      'x-razorpay-signature',
      'event',
      req,
      res,
    );
  }

  @Post('stripe')
  @RateLimit(LIMITS.webhooks)
  stripe(@Req() req: Request, @Res() res: Response) {
    return this.handle(
      'stripe',
      'Stripe',
      'stripe-signature',
      'type',
      req,
      res,
    );
  }

  private async handle(
    name: 'razorpay' | 'stripe',
    label: string,
    header: string,
    typeKey: string,
    req: Request,
    res: Response,
  ) {
    const payload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const sig = req.headers[header];
    const signature = Array.isArray(sig) ? (sig[0] ?? '') : (sig ?? '');
    const gateway = this.billing.gateway(name);
    try {
      const event = gateway.verifyWebhook(payload, signature);
      const payment = await gateway.applyEvent(event);
      this.logger.log(
        `${label} webhook applied: event=${JSON.stringify(event[typeKey] ?? null)} payment_id=${String(payment?.id ?? null)}`,
      );
      res.status(200).json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`${label} webhook rejected: ${msg}`);
      // security: not in legacy: only signature/format problems are echoed; config
      // and database errors ("…SECRET not set") stay in the server log.
      res.status(400).json({
        ok: false,
        error: CLIENT_SAFE.test(msg) ? msg : 'Webhook rejected.',
      });
    }
  }
}
