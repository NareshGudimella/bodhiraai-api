import { otpDelivery } from './env';

describe('otpDelivery', () => {
  it('sends by SMS whenever MSG91 is active', () => {
    expect(otpDelivery(true, { NODE_ENV: 'production' })).toBe('sms');
    expect(otpDelivery(true, { NODE_ENV: 'development' })).toBe('sms');
  });

  it('without SMS: off in production, the dev flow elsewhere', () => {
    expect(otpDelivery(false, { NODE_ENV: 'production' })).toBeNull();
    expect(otpDelivery(false, { NODE_ENV: 'development' })).toBe('dev');
    expect(otpDelivery(false, { NODE_ENV: 'test' })).toBe('dev');
  });

  it('ignores the retired OTP_LOGIN_ENABLED flag', () => {
    expect(
      otpDelivery(false, { NODE_ENV: 'production', OTP_LOGIN_ENABLED: '1' }),
    ).toBeNull();
  });
});
