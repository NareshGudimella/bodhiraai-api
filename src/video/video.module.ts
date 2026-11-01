import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { StudentModule } from '../student/student.module';
import { LessonPlaybackController } from './lesson-playback.controller';
import { VdoCipherClient } from './vdocipher.client';

/** security: not in legacy. Lesson videos on VdoCipher and the playback endpoint. */
@Module({
  imports: [StudentModule, AdminModule],
  controllers: [LessonPlaybackController],
  providers: [VdoCipherClient],
  exports: [VdoCipherClient],
})
export class VideoModule {}
