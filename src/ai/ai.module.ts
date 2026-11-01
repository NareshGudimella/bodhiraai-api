import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ClaudeClient } from './claude.client';
import { SubscriptionAccessService } from '../student/subscription-access.service';

@Module({
  controllers: [AiController],
  providers: [AiService, ClaudeClient, SubscriptionAccessService],
  exports: [AiService],
})
export class AiModule {}
