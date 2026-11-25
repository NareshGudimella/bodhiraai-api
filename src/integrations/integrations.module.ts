import { Global, Module } from '@nestjs/common';
import { IntegrationSettingsService } from './integration-settings.service';
import { Msg91Client } from './msg91.client';

/** not in legacy: provider settings from the super admin panel (Integrations). */
@Global()
@Module({
  providers: [IntegrationSettingsService, Msg91Client],
  exports: [IntegrationSettingsService, Msg91Client],
})
export class IntegrationsModule {}
