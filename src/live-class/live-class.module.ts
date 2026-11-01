import { Module } from '@nestjs/common';
import {
  StudentLiveClassController,
  TeacherLiveClassController,
} from './live-class.controller';
import { LiveClassService } from './live-class.service';
import { SubscriptionAccessService } from '../student/subscription-access.service';

@Module({
  controllers: [StudentLiveClassController, TeacherLiveClassController],
  providers: [LiveClassService, SubscriptionAccessService],
  exports: [LiveClassService],
})
export class LiveClassModule {}
