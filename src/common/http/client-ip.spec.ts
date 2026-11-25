import type { NextFunction, Request, Response } from 'express';
import { derivedKey } from '../../config/app-secret';
import { clientIp } from './client-ip';

const APP_SECRET = Buffer.alloc(32, 3).toString('base64');
/** The X-Proxy-Secret the Worker sends: derived from APP_SECRET. */
const PROXY = derivedKey('proxy', { APP_SECRET })!;

function run(
  headers: Record<string, string>,
  secret?: string,
  path = '/api/v1/auth/login',
) {
  const before = process.env.APP_SECRET;
  if (secret === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = secret;
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
  if (before === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = before;
  return { ip: req.ip, passed, status };
}

describe('clientIp', () => {
  const visitor = { 'x-client-ip': '203.0.113.7' };

  it('uses X-Client-IP with the shared secret', () => {
    expect(run({ ...visitor, 'x-proxy-secret': PROXY }, APP_SECRET)).toEqual({
      ip: '203.0.113.7',
      passed: true,
      status: null,
    });
  });

  it('keeps req.ip with the secret but no X-Client-IP', () => {
    expect(run({ 'x-proxy-secret': PROXY }, APP_SECRET).ip).toBe('10.0.0.5');
  });

  it('refuses a wrong or missing secret with 403', () => {
    expect(run({ ...visitor, 'x-proxy-secret': 'wrong!' }, APP_SECRET)).toEqual(
      {
        ip: '10.0.0.5',
        passed: false,
        status: 403,
      },
    );
    expect(run(visitor, APP_SECRET).status).toBe(403);
  });

  it('lets probes through without the secret', () => {
    expect(run({}, APP_SECRET, '/api/v1/ping').passed).toBe(true);
    expect(run({}, APP_SECRET, '/health').passed).toBe(true);
  });

  it('changes nothing when APP_SECRET is not configured', () => {
    expect(run({ ...visitor, 'x-proxy-secret': '' })).toEqual({
      ip: '10.0.0.5',
      passed: true,
      status: null,
    });
  });
});

describe('APP_SECRET is not the proxy secret (security: not in legacy)', () => {
  it('refuses the raw APP_SECRET as X-Proxy-Secret', () => {
    expect(run({ 'x-proxy-secret': APP_SECRET }, APP_SECRET).status).toBe(403);
  });
});
