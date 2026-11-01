import { otpLoginEnabled } from './env';

describe('otpLoginEnabled', () => {
  it('is off by default in production and on elsewhere', () => {
    expect(otpLoginEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(otpLoginEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(otpLoginEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('follows OTP_LOGIN_ENABLED when it is set', () => {
    expect(
      otpLoginEnabled({ NODE_ENV: 'production', OTP_LOGIN_ENABLED: '1' }),
    ).toBe(true);
    expect(
      otpLoginEnabled({ NODE_ENV: 'production', OTP_LOGIN_ENABLED: 'true' }),
    ).toBe(true);
    expect(
      otpLoginEnabled({ NODE_ENV: 'development', OTP_LOGIN_ENABLED: '0' }),
    ).toBe(false);
    expect(
      otpLoginEnabled({ NODE_ENV: 'development', OTP_LOGIN_ENABLED: 'false' }),
    ).toBe(false);
  });
});
