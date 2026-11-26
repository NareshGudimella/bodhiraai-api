import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { StudentModule } from '../student/student.module';
import { HlsController } from './hls.controller';
import { LessonPlaybackController } from './lesson-playback.controller';
import { VideoJobs } from './video-jobs.service';

/** not in legacy. Self-hosted encrypted-HLS lesson videos and the playback endpoints. */
@Module({
  imports: [StudentModule, AdminModule],
  controllers: [LessonPlaybackController, HlsController],
  providers: [VideoJobs],
  exports: [VideoJobs],
})
export class VideoModule {}
