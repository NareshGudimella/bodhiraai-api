import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TeacherModule } from '../teacher/teacher.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SchoolWebController } from './school-web.controller';

@Module({
  imports: [TeacherModule, AuthModule],
  controllers: [AdminController, SchoolWebController],
  providers: [AdminService],
})
export class AdminModule {}
