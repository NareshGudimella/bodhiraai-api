import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
} from '@nestjs/common';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { laravelValidate } from '../common/http/laravel-validator';
import { AuditService } from '../cms/audit.service';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import type { users } from '../db/types';
import { MailKeyError } from '../mail/mail-crypto';
import {
  MailSettingsService,
  type MailSettingsInput,
} from '../mail/mail-settings.service';
import { MailService } from '../mail/mail.service';

/** The audit row's subject (there is no legacy model; the single `mail_settings` row). */
const SUBJECT = { type: 'App\\Models\\MailSettings', id: 1n };

/**
 * not in legacy: /api/v1/super/mail-settings. The platform's outgoing-mail (SMTP)
 * settings, editable by super admins. The password is write-only: responses carry
 * `password_set` only, and a blank password on save keeps the stored one.
 */
@Controller('super/mail-settings')
@Roles(Role.SuperAdmin)
export class MailSettingsController {
  constructor(
    private readonly settings: MailSettingsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async show() {
    return ok(await this.settings.view());
  }

  @Put()
  async update(
    @Body() body: unknown,
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
  ) {
    const data = await laravelValidate(this.db, body, {
      mailer: ['required', 'in:smtp,log'],
      host: ['required_if:mailer,smtp', 'nullable', 'string', 'max:190'],
      port: [
        'required_if:mailer,smtp',
        'nullable',
        'integer',
        'min:1',
        'max:65535',
      ],
      encryption: ['nullable', 'in:tls,ssl,none'],
      username: ['nullable', 'string', 'max:190'],
      password: ['nullable', 'string', 'max:500'],
      from_address: ['required', 'email', 'max:190'],
      from_name: ['nullable', 'string', 'max:120'],
    });
    const input: MailSettingsInput = {
      mailer: data.mailer as 'smtp' | 'log',
      host: (data.host as string | null) ?? null,
      port: data.port == null ? null : Number(data.port),
      encryption: (data.encryption as MailSettingsInput['encryption']) ?? null,
      username: (data.username as string | null) ?? null,
      password: (data.password as string | null) ?? null,
      from_address: data.from_address as string,
      from_name: (data.from_name as string | null) ?? null,
    };

    let result: { password_changed: boolean };
    try {
      result = await this.settings.save(input, user.id);
    } catch (e) {
      if (e instanceof MailKeyError) {
        throw new ApiException(
          "The SMTP password can't be stored: MAIL_SETTINGS_KEY is not configured correctly on the server.",
          503,
          'mail_key_missing',
        );
      }
      throw e;
    }
    await this.audit.log(user, client, 'mail_settings.updated', SUBJECT, {
      mailer: input.mailer,
      host: input.host,
      port: input.port,
      encryption: input.encryption,
      username: input.username,
      from_address: input.from_address,
      from_name: input.from_name,
      password_changed: result.password_changed, // never the password itself
    });
    return ok(await this.settings.view(), 'Mail settings saved.');
  }

  /** Sends with the saved settings. A failure is a 200 with `sent: false` and the sanitised SMTP error. */
  @Post('test')
  @HttpCode(200)
  @RateLimit(5, 'user')
  async test(
    @Body() body: unknown,
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
  ) {
    const data = await laravelValidate(this.db, body, {
      to: ['required', 'email', 'max:190'],
    });
    const result = await this.mail.sendTest(data.to as string);
    await this.audit.log(user, client, 'mail_settings.test_sent', SUBJECT, {
      sent: result.sent,
    });
    return ok(result, result.sent ? 'Test email sent.' : 'Test email failed.');
  }
}
