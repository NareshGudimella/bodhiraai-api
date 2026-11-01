import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { redisThrottlerStorage } from './common/http/redis-throttler-storage';
import { AccountModule } from './account/account.module';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { ChatModule } from './chat/chat.module';
import { CmsModule } from './cms/cms.module';
import { RateLimiterModule } from './common/rate-limiter';
import { RolesGuard } from './common/guards/roles.guard';
import { TokenAuthGuard } from './common/guards/token-auth.guard';
import { TransformRequestMiddleware } from './common/http/transform-request.middleware';
import { HealthController } from './health/health.controller';
import { LiveClassModule } from './live-class/live-class.module';
import { MailModule } from './mail/mail.module';
import { NotificationModule } from './notification/notification.module';
import { ParentModule } from './parent/parent.module';
import { DbModule } from './db/db.module';
import { StorageModule } from './storage/storage.module';
import { SuperModule } from './super/super.module';
import { ContentModule } from './content/content.module';
import { StudentModule } from './student/student.module';
import { TeacherModule } from './teacher/teacher.module';
import { VideoModule } from './video/video.module';

@Module({
  imports: [
    // Storage/config for @RateLimit(). Nothing is limited unless a route opts in.
    // Counters live in Redis when REDIS_URL is set (several instances), else in memory.
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [{ ttl: 60_000, limit: 60 }],
        storage: redisThrottlerStorage() ?? undefined,
      }),
    }),
    RateLimiterModule,
    DbModule,
    StorageModule,
    MailModule,
    NotificationModule,
    AuthModule,
    StudentModule,
    AiModule,
    LiveClassModule,
    TeacherModule,
    ParentModule,
    ChatModule,
    AccountModule,
    AdminModule,
    SuperModule,
    ContentModule,
    BillingModule,
    CmsModule,
    VideoModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate → authorize role. Rate limits are per route.
    { provide: APP_GUARD, useClass: TokenAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Runs after body parsing, before guards and validation (Laravel's global middleware).
    consumer.apply(TransformRequestMiddleware).forRoutes('*path');
  }
}
