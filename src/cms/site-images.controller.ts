import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { and, eq } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { cleanInput } from '../common/http/transform-request.middleware';
import { toStr } from '../common/http/laravel';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { site_settings } from '../db/schema';
import type { users } from '../db/types';
import { StorageService } from '../storage/storage.service';
import { sniff } from '../storage/upload-rules';
import {
  storeOrReject,
  uploadOptions,
  validateWithFiles,
} from '../storage/uploads';
import { AuditService } from './audit.service';
import type { MulterFile } from './cms-resource.controller';
import { SettingsService } from './settings.service';
import {
  IMAGE_EXTS,
  MAIN_IMAGES,
  SITE_IMAGES_GROUP,
  SITE_VIDEOS,
  SiteImagesService,
} from './site-images.service';

/**
 * Site Image Manager (legacy Cms\SiteImageController), redesigned for a
 * deployment that can't rewrite its own files: a replacement is uploaded to
 * storage and recorded as an override for the theme path (site_settings,
 * group `site_images`); the marketing pages resolve each path through the
 * overrides. "Restore" removes the override, so the bundled original shows.
 * Super, web admins and content managers; content managers only the curated
 * main images.
 */
@Controller('cms/images')
@Roles(Role.SuperAdmin, Role.WebAdmin, Role.ContentManager)
export class SiteImagesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly images: SiteImagesService,
  ) {}

  private canBrowseAll(user: users) {
    return user.role === (Role.SuperAdmin as string);
  }

  @Get()
  async index(@CurrentUser() user: users) {
    return ok({
      main: MAIN_IMAGES,
      videos: SITE_VIDEOS,
      overrides: await this.images.overrides(),
      can_browse_all: this.canBrowseAll(user),
    });
  }

  /** SiteImageController::resolveExisting(): a web path inside assets/img (curated only for content managers). */
  private checkPath(user: users, raw: unknown) {
    const path = toStr(raw).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path.startsWith('assets/img/'))
      throw new ApiException('Path must be inside assets/img.', 422);
    if (path.includes('..')) throw new ApiException('Invalid path.', 422);
    if (!IMAGE_EXTS.includes((path.split('.').pop() ?? '').toLowerCase())) {
      throw new ApiException('Image not found.', 404);
    }
    const curated = Object.values(MAIN_IMAGES)
      .flat()
      .some((i) => i.path === path);
    if (!this.canBrowseAll(user) && !curated) {
      throw new ApiException('You can only edit the main site images.', 403);
    }
    return path;
  }

  private async setOverride(path: string, url: string | null) {
    const old = (await this.images.overrides())[path];
    if (old) await this.storage.delete(old);
    if (url === null) {
      await this.db
        .delete(site_settings)
        .where(
          and(
            eq(site_settings.group, SITE_IMAGES_GROUP),
            eq(site_settings.key, path),
          ),
        );
    } else {
      await this.settings.setMany({ [`${SITE_IMAGES_GROUP}.${path}`]: url });
    }
  }

  @Post('replace')
  @UseInterceptors(AnyFilesInterceptor(uploadOptions(11, 1)))
  async replace(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Body() body: unknown,
    @UploadedFiles() files: MulterFile[] = [],
  ) {
    const image = files.find((f) => f.fieldname === 'image');
    const data = await validateWithFiles(
      this.db,
      body,
      { path: ['required', 'string'], image: ['nullable'] },
      { image },
      [{ field: 'image', kind: 'image', maxKb: 10240 }],
    );
    if (!image) {
      throw new ApiException('The given data was invalid.', 422, undefined, {
        image: ['The image field is required.'],
      });
    }
    const path = this.checkPath(user, data.path);
    const url = await storeOrReject('image', () =>
      this.storage.storeCloud(image, 'image'),
    );
    await this.setOverride(path, url);
    await this.audit.log(user, client, 'cms.image.replaced', null, { path });
    return ok(
      { path, url },
      `Replaced ${path}. The new image is now live across the site.`,
    );
  }

  @Post('restore')
  async restore(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Body() raw: unknown,
  ) {
    const body = (cleanInput(raw) ?? {}) as Record<string, unknown>;
    if (body.path === null || body.path === undefined) {
      throw new ApiException('The given data was invalid.', 422, undefined, {
        path: ['The path field is required.'],
      });
    }
    const path = this.checkPath(user, body.path);
    if (!(await this.images.overrides())[path]) {
      throw new ApiException('No original backup exists for this image.', 404);
    }
    await this.setOverride(path, null);
    await this.audit.log(user, client, 'cms.image.restored', null, { path });
    return ok({ path }, `Restored the original ${path}.`);
  }

  @Post('video')
  @UseInterceptors(AnyFilesInterceptor(uploadOptions(151, 1)))
  async video(
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
    @Body() raw: unknown,
    @UploadedFiles() files: MulterFile[] = [],
  ) {
    const body = (cleanInput(raw) ?? {}) as Record<string, unknown>;
    const video = files.find((f) => f.fieldname === 'video');
    const errors: Record<string, string[]> = {};
    if (body.path === null || body.path === undefined)
      errors.path = ['The path field is required.'];
    if (!video) errors.video = ['The video field is required.'];
    else if (!['mp4', 'matroska'].includes(sniff(video.buffer))) {
      errors.video = [
        'The video field must be a file of type: video/mp4, video/webm, video/ogg.',
      ];
    } else if (video.size > 153600 * 1024) {
      errors.video = [
        'The video field must not be greater than 153600 kilobytes.',
      ];
    }
    if (Object.keys(errors).length)
      throw new ApiException(
        'The given data was invalid.',
        422,
        undefined,
        errors,
      );
    const path = toStr(body.path).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!SITE_VIDEOS.some((v) => v.path === path))
      throw new ApiException('Unknown video slot.', 403);
    const url = await storeOrReject('video', () =>
      this.storage.store(video!, 'video', 'site/videos'),
    );
    await this.setOverride(path, url);
    await this.audit.log(user, client, 'cms.video.replaced', null, { path });
    return ok({ path, url }, 'Replaced video. It is now live across the site.');
  }
}
