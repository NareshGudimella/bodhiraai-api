import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { StudentAssignmentsController } from './student-assignments.controller';
import { StudentReportService } from './student-report.service';
import { StudentController } from './student.controller';
import { StudentService } from './student.service';
import { SubscribedGuard } from './subscribed.guard';
import { SubscriptionAccessService } from './subscription-access.service';

@Module({
  imports: [AiModule],
  controllers: [StudentController, StudentAssignmentsController],
  providers: [
    StudentService,
    StudentReportService,
    SubscriptionAccessService,
    SubscribedGuard,
  ],
  exports: [StudentService, SubscriptionAccessService],
})
export class StudentModule {}
