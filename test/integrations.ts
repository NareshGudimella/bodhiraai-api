import type { INestApplicationContext } from '@nestjs/common';
import { IntegrationSettingsService } from '../src/integrations/integration-settings.service';
import {
  defaultsOf,
  type Configs,
  type Provider,
} from '../src/integrations/integrations';

/**
 * not in legacy: provider settings for one suite, in this process only (what
 * setEnv() did for R2_*, RAZORPAY_* etc. before the settings moved to the
 * database). The database is neither read nor written, so suites running in
 * parallel never see each other's settings. test/integrations.serial-e2e-spec.ts
 * covers the real store.
 */
export function stubIntegrations(app: INestApplicationContext) {
  const values: { [P in Provider]?: Partial<Configs[P]> } = {};
  jest
    .spyOn(app.get(IntegrationSettingsService), 'get')
    .mockImplementation(<P extends Provider>(p: P) =>
      Promise.resolve({ ...defaultsOf(p), ...values[p] }),
    );
  return {
    set<P extends Provider>(p: P, v: Partial<Configs[P]>) {
      values[p] = { ...values[p], ...v };
    },
    reset(p: Provider) {
      delete values[p];
    },
  };
}
