import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ParentModule } from '../parent/parent.module';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';
import { TeacherController } from './teacher.controller';
import { TeacherService } from './teacher.service';

@Module({
  imports: [ParentModule, AuthModule],
  controllers: [TeacherController, RosterController],
  providers: [TeacherService, RosterService],
  exports: [TeacherService, RosterService],
})
export class TeacherModule {}
