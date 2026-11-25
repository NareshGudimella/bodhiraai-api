import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { derivedKey } from '../../config/app-secret';

/** Load-balancer and monitoring probes, which can't send the secret. */
const OPEN_PATHS = new Set(['/api/v1/ping', '/health']);

/**
 * Behind Cloudflare. The edge Worker and the web app's server send
 * PROXY_SECRET (derived from APP_SECRET, purpose `proxy`) in X-Proxy-Secret, plus the visitor's address in X-Client-IP
 * (they reach the API from addresses that can't be listed in TRUST_PROXY).
 * With APP_SECRET set:
 * - a request with the right secret gets `req.ip` from X-Client-IP;
 * - any other request is refused with 403, except the probes in OPEN_PATHS,
 *   so the origin can't be used around the Worker.
 * Without APP_SECRET (local development) nothing changes: `req.ip` comes
 * from X-Forwarded-For and TRUST_PROXY. Production refuses to start without
 * APP_SECRET (assertAppSecret in main.ts).
 */
export function clientIp() {
  const key = derivedKey('proxy');
  const secret = key ? Buffer.from(key) : null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!secret) return next();
    const given = req.headers['x-proxy-secret'];
    const valid =
      typeof given === 'string' &&
      given.length === secret.length &&
      timingSafeEqual(Buffer.from(given), secret);
    if (!valid) {
      if (OPEN_PATHS.has(req.path)) return next();
      res.status(403).json({ success: false, message: 'Forbidden.' });
      return;
    }
    // security: not in legacy: lets /health tell the Worker/web server from the public.
    (req as Request & { proxyAuthenticated?: boolean }).proxyAuthenticated =
      true;
    const ip = req.headers['x-client-ip'];
    if (typeof ip === 'string' && ip !== '') {
      Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    }
    next();
  };
}
