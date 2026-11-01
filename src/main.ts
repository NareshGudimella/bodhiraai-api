// Timestamps are stored in UTC without a zone (as Laravel stored them), and
// Date handling uses the process timezone. Pin it to UTC before anything touches the DB.
process.env.TZ = 'UTC';

import { loadEnv } from './config/env';
loadEnv();

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { assertFileUrlConfig } from './storage/file-url';
import { assertVdoCipherConfig } from './video/vdocipher.client';

async function bootstrap() {
  // security: not in legacy. Fail closed: production refuses to start without
  // FILE_URL_SECRET/FILES_BASE_URL (signed private-file links).
  assertFileUrlConfig();
  assertVdoCipherConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 4000));
}
void bootstrap();
