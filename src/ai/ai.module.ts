import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ClaudeClient } from './claude.client';

@Module({
  controllers: [AiController],
  providers: [AiService, ClaudeClient],
  exports: [AiService],
})
export class AiModule {}
