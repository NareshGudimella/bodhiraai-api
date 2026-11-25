import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { CmsModule } from '../cms/cms.module';
import { ContentModule } from '../content/content.module';
import { VideoModule } from '../video/video.module';
import { CatalogueController } from './catalogue.controller';
import { IntegrationsController } from './integrations.controller';
import { MailSettingsController } from './mail-settings.controller';
import { SchoolAdminsController } from './school-admins.controller';
import { SchoolAdminsService } from './school-admins.service';
import { SuperController } from './super.controller';
import { SuperService } from './super.service';

@Module({
  imports: [ContentModule, CmsModule, AuthModule, AiModule, VideoModule],
  controllers: [
    SuperController,
    CatalogueController,
    MailSettingsController,
    IntegrationsController,
    SchoolAdminsController,
  ],
  providers: [SuperService, SchoolAdminsService],
})
export class SuperModule {}
