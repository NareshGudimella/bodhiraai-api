import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TeacherModule } from '../teacher/teacher.module';
import { LiveClassModule } from '../live-class/live-class.module';
import { AdminContentService } from './admin-content.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SchoolWebController } from './school-web.controller';

@Module({
  imports: [TeacherModule, AuthModule, LiveClassModule],
  controllers: [AdminController, SchoolWebController],
  providers: [AdminService, AdminContentService],
  exports: [AdminContentService],
})
export class AdminModule {}
