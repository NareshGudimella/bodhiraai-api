import type { NextFunction, Request, Response } from 'express';
import { clientIp } from './client-ip';

function run(
  headers: Record<string, string>,
  secret?: string,
  path = '/api/v1/auth/login',
) {
  const before = process.env.PROXY_SECRET;
  if (secret === undefined) delete process.env.PROXY_SECRET;
  else process.env.PROXY_SECRET = secret;
  const req = { headers, ip: '10.0.0.5', path } as unknown as Request;
  let status: number | null = null;
  const res = {
    json: () => undefined,
  } as unknown as Response & { status: (code: number) => Response };
  res.status = (code: number) => {
    status = code;
    return res;
  };
  let passed = false;
  clientIp()(req, res, (() => (passed = true)) as NextFunction);
  process.env.PROXY_SECRET = before;
  return { ip: req.ip, passed, status };
}

describe('clientIp', () => {
  const visitor = { 'x-client-ip': '203.0.113.7' };

  it('uses X-Client-IP with the shared secret', () => {
    expect(run({ ...visitor, 'x-proxy-secret': 's3cret' }, 's3cret')).toEqual({
      ip: '203.0.113.7',
      passed: true,
      status: null,
    });
  });

  it('keeps req.ip with the secret but no X-Client-IP', () => {
    expect(run({ 'x-proxy-secret': 's3cret' }, 's3cret').ip).toBe('10.0.0.5');
  });

  it('refuses a wrong or missing secret with 403', () => {
    expect(run({ ...visitor, 'x-proxy-secret': 'wrong!' }, 's3cret')).toEqual({
      ip: '10.0.0.5',
      passed: false,
      status: 403,
    });
    expect(run(visitor, 's3cret').status).toBe(403);
  });

  it('lets probes through without the secret', () => {
    expect(run({}, 's3cret', '/api/v1/ping').passed).toBe(true);
    expect(run({}, 's3cret', '/health').passed).toBe(true);
  });

  it('changes nothing when PROXY_SECRET is not configured', () => {
    expect(run({ ...visitor, 'x-proxy-secret': '' })).toEqual({
      ip: '10.0.0.5',
      passed: true,
      status: null,
    });
  });
});
