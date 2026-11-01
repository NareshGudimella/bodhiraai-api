import { RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import type { ServerResponse } from 'node:http';
import helmet from 'helmet';
import { filesHandler } from './storage/files.handler';
import { StorageService } from './storage/storage.service';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { apiValidationPipe } from './common/http/validation';
import { clientIp } from './common/http/client-ip';

/** HTTP setup shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication) {
  // The web app's server calls the API on behalf of visitors and forwards
  // their address in X-Forwarded-For; only these proxies are believed.
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  // Behind Cloudflare: X-Client-IP with the shared secret (client-ip.ts).
  app.use(clientIp());

  // Same URL space as the legacy Laravel API: /api/v1/*. Gateway webhooks keep
  // their legacy web URLs (/webhooks/*) and get the raw body for the HMAC.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'webhooks/razorpay', method: RequestMethod.POST },
      { path: 'webhooks/stripe', method: RequestMethod.POST },
      // Load-balancer probe, at the legacy web URL.
      { path: 'health', method: RequestMethod.GET },
    ],
  });
  app.use('/webhooks', raw({ type: () => true, limit: '1mb' }));
  // Uploaded files (local driver) are embedded by the web app on another origin.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  if (process.env.STORAGE_DRIVER !== 'r2') {
    app.useStaticAssets(StorageService.localDir(), {
      prefix: '/uploads',
      dotfiles: 'deny',
      index: false,
      setHeaders: (res: ServerResponse) =>
        res.setHeader('X-Content-Type-Options', 'nosniff'),
    });
    // security: not in legacy. Private files behind signed links (file-url.ts);
    // production serves /files/* from the edge Worker instead.
    app.use('/files', filesHandler());
  }
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
    credentials: true,
  });

  // BIGINT ids come back as bigint; serialise them as JSON numbers like Laravel does.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? Number(value) : value,
  );

  app.useGlobalPipes(apiValidationPipe);
  app.useGlobalFilters(
    new ApiExceptionFilter(process.env.NODE_ENV !== 'production'),
  );
  return app;
}
