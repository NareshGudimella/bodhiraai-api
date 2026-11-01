import { Module } from '@nestjs/common';
import { CmsModule } from '../cms/cms.module';
import { ContentModule } from '../content/content.module';
import { CatalogueController } from './catalogue.controller';
import { MailSettingsController } from './mail-settings.controller';
import { SuperController } from './super.controller';
import { SuperService } from './super.service';

@Module({
  imports: [ContentModule, CmsModule],
  controllers: [SuperController, CatalogueController, MailSettingsController],
  providers: [SuperService],
})
export class SuperModule {}
