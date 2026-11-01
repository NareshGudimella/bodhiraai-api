import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailSettingsService } from './mail-settings.service';

@Global()
@Module({
  providers: [MailService, MailSettingsService],
  exports: [MailService, MailSettingsService],
})
export class MailModule {}
