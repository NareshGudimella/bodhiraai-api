import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CmsLeadsController } from './cms-leads.controller';
import { CmsPagesController } from './cms-pages.controller';
import { CmsPostsController } from './cms-posts.controller';
import { RESOURCE_CONTROLLERS } from './cms-resource.controller';
import { CmsSiteController } from './cms-site.controller';
import { LeadsController } from './leads.controller';
import { SettingsService } from './settings.service';
import { SiteController } from './site.controller';
import { SiteImagesController } from './site-images.controller';
import { SiteImagesService } from './site-images.service';
import { VideoController } from './video.controller';

@Module({
  controllers: [
    CmsSiteController,
    CmsPagesController,
    CmsPostsController,
    CmsLeadsController,
    ...RESOURCE_CONTROLLERS,
    LeadsController,
    SiteController,
    SiteImagesController,
    VideoController,
  ],
  providers: [AuditService, SettingsService, SiteImagesService],
  exports: [AuditService, SettingsService],
})
export class CmsModule {}
