import {
  coerce,
  defaultsOf,
  isConfigured,
  PROVIDERS,
  sanitizeError,
  secretFields,
} from './integrations';
import { msg91Mobile } from './msg91.client';

describe('integrations', () => {
  it('lists the write-only fields per provider', () => {
    expect(secretFields('payments')).toEqual([
      'razorpay_key_secret',
      'razorpay_webhook_secret',
      'stripe_secret',
      'stripe_webhook_secret',
    ]);
    expect(secretFields('storage')).toEqual(['secret_access_key']);
  });

  it('coerces form values to their stored form', () => {
    const { enabled } = PROVIDERS.sms;
    expect(coerce(enabled, '1')).toBe(true);
    expect(coerce(enabled, '0')).toBe(false);
    expect(coerce(enabled, undefined)).toBe(false);
    expect(coerce(PROVIDERS.ai.max_tokens, '512')).toBe(512);
    expect(coerce(PROVIDERS.ai.max_tokens, '')).toBeNull();
    expect(coerce(PROVIDERS.payments.gateway, null)).toBe('none');
    expect(coerce(PROVIDERS.ai.model, ' m ')).toBe('m');
  });

  it('is configured only when complete (and enabled, for SMS)', () => {
    expect(isConfigured('payments', defaultsOf('payments'))).toBe(false);
    const rzp = {
      ...defaultsOf('payments'),
      gateway: 'razorpay' as const,
      razorpay_key_id: 'rzp_x',
      razorpay_key_secret: 's',
    };
    expect(isConfigured('payments', rzp)).toBe(true);
    expect(isConfigured('payments', { ...rzp, gateway: 'none' })).toBe(false);
    const sms = {
      enabled: true,
      auth_key: 'k',
      sender_id: null,
      template_id: 't',
    };
    expect(isConfigured('sms', sms)).toBe(true);
    expect(isConfigured('sms', { ...sms, enabled: false })).toBe(false);
    expect(isConfigured('sms', { ...sms, template_id: null })).toBe(false);
  });

  it('masks secrets in error text', () => {
    expect(
      sanitizeError(new Error('bad key abc123 here'), ['abc123', null]),
    ).toBe('bad key *** here');
  });

  it('formats MSG91 mobile numbers', () => {
    expect(msg91Mobile('98765 43210')).toBe('919876543210');
    expect(msg91Mobile('+91 98765 43210')).toBe('919876543210');
    expect(msg91Mobile('+447700900123')).toBe('447700900123');
  });
});
