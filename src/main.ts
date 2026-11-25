// Timestamps are stored in UTC without a zone (as Laravel stored them), and
// Date handling uses the process timezone. Pin it to UTC before anything touches the DB.
process.env.TZ = 'UTC';

import { loadEnv } from './config/env';
loadEnv();

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { assertAppSecret } from './config/app-secret';
import { assertFileUrlConfig } from './storage/file-url';
import { Logger } from '@nestjs/common';
import { runWorker } from './worker';

async function bootstrap() {
  // security: not in legacy. Fail closed: production refuses to start without
  // APP_SECRET (settings encryption, signed file links, the proxy secret) or FILES_BASE_URL.
  assertAppSecret();
  assertFileUrlConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 4000));
}

// not in legacy: one build, two roles. APP_TYPE=WEB (default) serves the HTTP API
// (Elastic Beanstalk); APP_TYPE=WORKER runs the background jobs (PM2 on the worker host).
const appType = (process.env.APP_TYPE || 'WEB').trim().toUpperCase();
if (appType === 'WORKER')
  runWorker().catch((e: unknown) => {
    new Logger('Worker').error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
else if (appType === 'WEB') void bootstrap();
else {
  console.error(
    `APP_TYPE must be WEB or WORKER, not "${process.env.APP_TYPE}"`,
  );
  process.exit(1);
}
