// not in legacy: the background-job worker (BullMQ). Same build and environment
// as the API (DATABASE_URL, REDIS_URL, APP_SECRET, …; provider settings come
// from the database, Integrations); no HTTP server. Started by main.ts when
// APP_TYPE=WORKER (PM2 on the worker host, DEPLOY.md section 4).
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertAppSecret } from './config/app-secret';
import { JobsService } from './jobs/jobs.service';

export async function runWorker() {
  if (!process.env.REDIS_URL) throw new Error('The worker needs REDIS_URL');
  assertAppSecret();
  const app = await NestFactory.createApplicationContext(AppModule);
  // SIGTERM/SIGINT (pm2 stop/restart, Ctrl-C): finish running jobs, then close
  // the database pool and Redis.
  app.enableShutdownHooks();
  app.get(JobsService).startWorker();
}
