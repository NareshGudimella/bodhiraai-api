import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ClaudeClient } from '../ai/claude.client';
import { testGatewayKeys } from '../billing/gateways';
import { AuditService } from '../cms/audit.service';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit';
import { ApiException, ValidationFailed } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import type { users } from '../db/types';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import {
  fieldsOf,
  isProvider,
  PROVIDER_NAMES,
  sanitizeError,
  secretFields,
  type Provider,
} from '../integrations/integrations';
import { Msg91Client } from '../integrations/msg91.client';
import { MailKeyError } from '../mail/mail-crypto';
import { StorageService } from '../storage/storage.service';

const provider = (raw: string): Provider => {
  if (!isProvider(raw)) throw new ApiException('Unknown integration.', 404);
  return raw;
};

/**
 * not in legacy: /api/v1/super/integrations. Provider settings (R2 storage,
 * MSG91 SMS, payment gateways, the AI tutor) edited by super admins;
 * the API reads them from here instead of the environment. Secrets are
 * write-only: an Item carries `secrets: {field: isSet}`, a blank secret on
 * save keeps the stored one, DELETE …/secrets/:field clears one. Every change
 * is audited (field names only, never a secret). Email stays at
 * /super/mail-settings.
 */
@Controller('super/integrations')
@Roles(Role.SuperAdmin)
export class IntegrationsController {
  constructor(
    private readonly settings: IntegrationSettingsService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly sms: Msg91Client,
    private readonly claude: ClaudeClient,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async index() {
    const out: Record<string, unknown> = {};
    for (const p of PROVIDER_NAMES) out[p] = await this.settings.view(p);
    return ok(out);
  }

  @Get(':provider')
  async show(@Param('provider') raw: string) {
    return ok(await this.settings.view(provider(raw)));
  }

  @Put(':provider')
  async update(
    @Param('provider') raw: string,
    @Body() body: unknown,
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
  ) {
    const p = provider(raw);
    const input = {
      ...(body && typeof body === 'object' ? body : {}),
    } as Record<string, unknown>;
    // JSON clients send booleans; the rules compare strings like a form post.
    if (typeof input.enabled === 'boolean')
      input.enabled = input.enabled ? '1' : '0';
    const data = await laravelValidate(
      this.db,
      input,
      Object.fromEntries(fieldsOf(p).map(([name, f]) => [name, f.rules])),
    );
    if (
      p === 'sms' &&
      ['1', 1, true].includes(data.enabled as never) &&
      !data.auth_key &&
      !(await this.settings.view('sms')).secrets.auth_key
    )
      throw ValidationFailed.field(
        'auth_key',
        'The auth key field is required when SMS is enabled.',
      );

    let changed: string[];
    try {
      changed = await this.settings.save(p, data, user.id);
    } catch (e) {
      if (e instanceof MailKeyError)
        throw new ApiException(
          "Secrets can't be stored: APP_SECRET is not configured correctly on the server.",
          503,
          'settings_key_missing',
        );
      throw e;
    }
    const view = await this.settings.view(p);
    await this.audit.log(user, client, 'integration_settings.updated', null, {
      provider: p,
      ...view.values,
      secrets_changed: changed, // names only, never a value
    });
    return ok(view, 'Settings saved.');
  }

  @Delete(':provider/secrets/:field')
  async clear(
    @Param('provider') raw: string,
    @Param('field') field: string,
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
  ) {
    const p = provider(raw);
    if (!secretFields(p).includes(field))
      throw new ApiException('Unknown secret.', 404);
    if (await this.settings.clear(p, field, user.id))
      await this.audit.log(
        user,
        client,
        'integration_settings.secret_cleared',
        null,
        { provider: p, secret: field },
      );
    return ok(await this.settings.view(p), 'Secret cleared.');
  }

  /**
   * A real call to the provider with the saved settings (never from tests in
   * CI; suites point the providers at local stubs). A failure is a 200 with
   * `ok: false` and the sanitised error.
   */
  @Post(':provider/test')
  @HttpCode(200)
  @RateLimit(10, 'user') // per super admin per minute, all providers together
  async test(
    @Param('provider') raw: string,
    @Body() body: unknown,
    @CurrentUser() user: users,
    @Client() client: ClientInfo,
  ) {
    const p = provider(raw);
    const phone =
      p === 'sms'
        ? ((
            await laravelValidate(this.db, body ?? {}, {
              phone: ['required', 'string', 'regex:/^\\+?[0-9]{10,15}$/'],
            })
          ).phone as string)
        : '';
    const cfg = await this.settings.get(p);
    let result: { ok: boolean; message: string };
    try {
      result = { ok: true, message: await this.run(p, phone) };
    } catch (e) {
      const secrets = secretFields(p).map(
        (f) => (cfg as unknown as Record<string, string | null>)[f],
      );
      result = { ok: false, message: sanitizeError(e, secrets) };
    }
    await this.audit.log(user, client, 'integration_settings.tested', null, {
      provider: p,
      ok: result.ok,
    });
    return ok(result, result.ok ? 'Test passed.' : 'Test failed.');
  }

  private async run(p: Provider, phone: string): Promise<string> {
    switch (p) {
      case 'storage':
        return `Reached bucket(s): ${(await this.storage.testBuckets()).join(', ')}.`;
      case 'sms': {
        const cfg = await this.settings.get('sms');
        if (!cfg.auth_key || !cfg.template_id)
          throw new Error('The auth key and template ID must be saved first.');
        await this.sms.sendOtp(cfg, phone, '123456');
        return `Test SMS sent to ${phone} (code 123456).`;
      }
      case 'payments':
        return `Keys accepted: ${(await testGatewayKeys(await this.settings.get('payments'))).join(', ')}.`;
      case 'ai':
        return `Anthropic answered (model ${await this.claude.test()}).`;
    }
  }
}
