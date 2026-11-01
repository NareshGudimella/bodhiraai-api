import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CmsModule } from '../cms/cms.module';
import { ContentModule } from '../content/content.module';
import { CatalogueController } from './catalogue.controller';
import { MailSettingsController } from './mail-settings.controller';
import { SchoolAdminsController } from './school-admins.controller';
import { SchoolAdminsService } from './school-admins.service';
import { SuperController } from './super.controller';
import { SuperService } from './super.service';

@Module({
  imports: [ContentModule, CmsModule, AuthModule],
  controllers: [
    SuperController,
    CatalogueController,
    MailSettingsController,
    SchoolAdminsController,
  ],
  providers: [SuperService, SchoolAdminsService],
})
export class SuperModule {}
