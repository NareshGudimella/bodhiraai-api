process.env.TZ = 'UTC';

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, like } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ClaudeClient } from '../src/ai/claude.client';
import { BillingService } from '../src/billing/billing.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import { audit_logs, integration_settings } from '../src/db/schema';
import { IntegrationSettingsService } from '../src/integrations/integration-settings.service';
import { StorageService } from '../src/storage/storage.service';

loadEnv();

interface Call {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

/**
 * not in legacy: /super/integrations and the settings store, end to end.
 * Writes the shared `integration_settings` table, so `npm run test:e2e` runs
 * this file on its own after the parallel suites (`*.serial-e2e-spec.ts`).
 * Every provider is a local stub (R2, Anthropic, MSG91 over HTTP;
 * Razorpay/Stripe through a fetch spy): nothing reaches a real service.
 * Leaves no integration_settings rows behind.
 */
describe('Super admin integrations (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let sup: { Authorization: string };
  let student: { Authorization: string };
  let stub: Server;
  const calls: Call[] = [];
  /** Status per bucket name for the R2 stub (default 200). */
  const bucketStatus: Record<string, number> = {};
  const envBefore: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const URL = '/api/v1/super/integrations';
  const realFetch = global.fetch;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const callsTo = (prefix: string) =>
    calls.filter((c) => c.url.startsWith(prefix));
  const row = async (p: string) =>
    (
      await db
        .select()
        .from(integration_settings)
        .where(eq(integration_settings.provider, p))
    )[0];

  const login = async (identifier: string) => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'password', device: 'e2e-integrations' })
      .expect(200);
    return { Authorization: `Bearer ${res.body.data.token as string}` };
  };

  const STORAGE = {
    account_id: 'acc123',
    access_key_id: 'AKIDFIRST',
    secret_access_key: 'r2-secret-one-never-shown',
    bucket: 'uploads-e2e',
    public_url: 'https://files.e2e.test',
    private_bucket: 'private-e2e',
    legacy_bucket: null,
  };

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = req.url ?? '';
        calls.push({ method: req.method ?? '', url, headers: req.headers });
        res.setHeader('Content-Type', 'application/json');
        if (url.startsWith('/r2/')) {
          const bucket = url.slice(4).split(/[/?]/)[0];
          res.statusCode = bucketStatus[bucket] ?? 200;
          res.setHeader('ETag', '"e"');
          return res.end();
        }
        if (url.startsWith('/anthropic/v1/messages'))
          return res.end(
            JSON.stringify({
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-stub',
              content: [{ type: 'text', text: 'pong' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 1 },
            }),
          );
        if (url.startsWith('/msg91/otp'))
          return res.end(JSON.stringify({ type: 'success', request_id: 'r' }));
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    setEnv('STORAGE_DRIVER', 'r2');
    setEnv('R2_ENDPOINT', `${base}/r2`);
    setEnv('ANTHROPIC_BASE_URL', `${base}/anthropic`);
    setEnv('MSG91_API_BASE', `${base}/msg91`);
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.razorpay.com/')) {
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        calls.push({ method: 'GET', url, headers: { authorization: auth } });
        const good = auth.includes(
          Buffer.from('rzp_test_good:rzp-secret').toString('base64'),
        );
        return Promise.resolve(
          new Response('{"items":[]}', { status: good ? 200 : 401 }),
        );
      }
      if (url.startsWith('https://')) throw new Error(`unexpected ${url}`);
      return realFetch(input, init);
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    await db.delete(integration_settings);
    sup = await login('super@bodhira.test');
    student = await login('student@bodhira.test');
  });

  afterAll(async () => {
    await db.delete(integration_settings);
    await app.close();
    fetchSpy.mockRestore();
    stub.close();
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is super admin only; unknown providers and secrets are 404', async () => {
    await http().get(URL).expect(401);
    await http().get(URL).set(student).expect(403);
    await http().get(`${URL}/ai`).set(student).expect(403);
    await http().put(`${URL}/ai`).set(student).send({}).expect(403);
    await http().delete(`${URL}/ai/secrets/api_key`).set(student).expect(403);
    await http().post(`${URL}/ai/test`).set(student).expect(403);
    await http().get(`${URL}/mail`).set(sup).expect(404);
    await http().put(`${URL}/nope`).set(sup).send({}).expect(404);
    await http().delete(`${URL}/ai/secrets/model`).set(sup).expect(404);
  });

  it('GET lists every provider with defaults and no secret values', async () => {
    const res = await http().get(URL).set(sup).expect(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['ai', 'payments', 'sms', 'storage'].sort(),
    );
    expect(res.body.data.payments).toEqual({
      provider: 'payments',
      configured: false,
      updated_at: null,
      values: { gateway: 'none', razorpay_key_id: null, allow_demo: false },
      secrets: {
        razorpay_key_secret: false,
        razorpay_webhook_secret: false,
        stripe_secret: false,
        stripe_webhook_secret: false,
      },
    });
    expect(res.body.data.sms.values.enabled).toBe(false);
  });

  it('PUT validates with Laravel 422 keys and saves nothing', async () => {
    const bad = await http()
      .put(`${URL}/storage`)
      .set(sup)
      .send({
        ...STORAGE,
        bucket: 'Bad_Bucket',
        public_url: 'not a url',
        private_bucket: 'uploads-e2e',
        legacy_bucket: 'uploads-e2e',
      })
      .expect(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual(
      ['bucket', 'public_url'].sort(),
    );
    const same = await http()
      .put(`${URL}/storage`)
      .set(sup)
      .send({ ...STORAGE, private_bucket: STORAGE.bucket })
      .expect(422);
    expect(Object.keys(same.body.errors)).toEqual(['private_bucket']);
    const pay = await http()
      .put(`${URL}/payments`)
      .set(sup)
      .send({ gateway: 'paypal' })
      .expect(422);
    expect(Object.keys(pay.body.errors)).toEqual(['gateway']);
    const sms = await http()
      .put(`${URL}/sms`)
      .set(sup)
      .send({ enabled: true })
      .expect(422);
    expect(Object.keys(sms.body.errors)).toEqual(['template_id']);
    const smsKey = await http()
      .put(`${URL}/sms`)
      .set(sup)
      .send({ enabled: '1', template_id: 'tmpl1' })
      .expect(422);
    expect(Object.keys(smsKey.body.errors)).toEqual(['auth_key']);
    const ai = await http()
      .put(`${URL}/ai`)
      .set(sup)
      .send({ max_tokens: 0, model: 'bad model' })
      .expect(422);
    expect(Object.keys(ai.body.errors).sort()).toEqual(['max_tokens', 'model']);
    expect(await db.select().from(integration_settings)).toHaveLength(0);
  });

  it('PUT encrypts secrets, never returns them, audits without them; storage uses them at once', async () => {
    const storage = app.get(StorageService);
    const res = await http()
      .put(`${URL}/storage`)
      .set(sup)
      .send(STORAGE)
      .expect(200);
    expect(res.body.data).toMatchObject({
      provider: 'storage',
      configured: true,
      values: { bucket: 'uploads-e2e', account_id: 'acc123' },
      secrets: { secret_access_key: true },
    });
    expect(JSON.stringify(res.body)).not.toContain(STORAGE.secret_access_key);
    const stored = await row('storage');
    expect(stored.secrets.secret_access_key).toMatch(/^v1:/);
    expect(JSON.stringify([stored.settings, stored.secrets])).not.toContain(
      STORAGE.secret_access_key,
    );
    const [log] = await db
      .select()
      .from(audit_logs)
      .where(eq(audit_logs.action, 'integration_settings.updated'))
      .orderBy(audit_logs.id);
    expect(log.changes).toContain('secret_access_key');
    expect(
      (
        await db
          .select()
          .from(audit_logs)
          .where(like(audit_logs.changes, `%${STORAGE.secret_access_key}%`))
      ).length,
    ).toBe(0);

    // A consumer (no restart): uploads go to the saved bucket with the saved key.
    const url = await storage.putBytes(
      'e2e/a.txt',
      Buffer.from('a'),
      'text/plain',
    );
    expect(url).toBe('https://files.e2e.test/e2e/a.txt');
    const put = callsTo('/r2/uploads-e2e/e2e/a.txt').pop()!;
    expect(put.method).toBe('PUT');
    expect(String(put.headers.authorization)).toContain('AKIDFIRST');

    // Blank secret keeps it; new plain values and key id apply to the next upload.
    await http()
      .put(`${URL}/storage`)
      .set(sup)
      .send({
        ...STORAGE,
        secret_access_key: '',
        access_key_id: 'AKIDSECOND',
        bucket: 'uploads-two',
      })
      .expect(200);
    expect((await row('storage')).secrets.secret_access_key).toBe(
      stored.secrets.secret_access_key,
    );
    await storage.putBytes('e2e/b.txt', Buffer.from('b'), 'text/plain');
    const put2 = callsTo('/r2/uploads-two/e2e/b.txt').pop()!;
    expect(String(put2.headers.authorization)).toContain('AKIDSECOND');
  });

  it('test endpoints report success and sanitised failures', async () => {
    const ok = await http().post(`${URL}/storage/test`).set(sup).expect(200);
    expect(ok.body.data).toEqual({
      ok: true,
      message: 'Reached bucket(s): uploads-two, private-e2e.',
    });
    bucketStatus['private-e2e'] = 403;
    const fail = await http().post(`${URL}/storage/test`).set(sup).expect(200);
    expect(fail.body.data.ok).toBe(false);
    expect(fail.body.data.message).toMatch(/private-e2e/);
    expect(JSON.stringify(fail.body)).not.toContain(STORAGE.secret_access_key);

    // AI: a tiny completion with the saved key and model.
    await http()
      .put(`${URL}/ai`)
      .set(sup)
      .send({ api_key: 'sk-ant-e2e', model: 'claude-stub', max_tokens: 50 })
      .expect(200);
    const ai = await http().post(`${URL}/ai/test`).set(sup).expect(200);
    expect(ai.body.data).toEqual({
      ok: true,
      message: 'Anthropic answered (model claude-stub).',
    });
    const sentKey = callsTo('/anthropic').pop()!.headers;
    expect([sentKey['x-api-key'], sentKey.authorization].join(' ')).toContain(
      'sk-ant-e2e',
    );
    expect(await app.get(ClaudeClient).live()).toEqual({
      apiKey: 'sk-ant-e2e',
      model: 'claude-stub',
      maxTokens: 50,
    });

    // MSG91: a test SMS to the given number.
    await http()
      .put(`${URL}/sms`)
      .set(sup)
      .send({ enabled: false, auth_key: 'msg-key', template_id: 'tmpl9' })
      .expect(200);
    const badPhone = await http()
      .post(`${URL}/sms/test`)
      .set(sup)
      .send({ phone: 'abc' })
      .expect(422);
    expect(Object.keys(badPhone.body.errors)).toEqual(['phone']);
    const sms = await http()
      .post(`${URL}/sms/test`)
      .set(sup)
      .send({ phone: '9876543210' })
      .expect(200);
    expect(sms.body.data.ok).toBe(true);
    const sent = callsTo('/msg91/otp').pop()!;
    expect(sent.headers.authkey).toBe('msg-key');
    expect(sent.url).toContain('mobile=919876543210');

    // Payments: a read-only call with the saved keys (wrong key = sanitised failure).
    await http()
      .put(`${URL}/payments`)
      .set(sup)
      .send({
        gateway: 'razorpay',
        razorpay_key_id: 'rzp_test_good',
        razorpay_key_secret: 'wrong-secret',
      })
      .expect(200);
    const bad = await http().post(`${URL}/payments/test`).set(sup).expect(200);
    expect(bad.body.data).toEqual({ ok: false, message: 'Razorpay: HTTP 401' });
    await http()
      .put(`${URL}/payments`)
      .set(sup)
      .send({
        gateway: 'razorpay',
        razorpay_key_id: 'rzp_test_good',
        razorpay_key_secret: 'rzp-secret',
      })
      .expect(200);
    const good = await http().post(`${URL}/payments/test`).set(sup).expect(200);
    expect(good.body.data.ok).toBe(true);
    expect(
      await db
        .select()
        .from(audit_logs)
        .where(eq(audit_logs.action, 'integration_settings.tested')),
    ).not.toHaveLength(0);
  });

  it('billing follows the saved gateway at once; `none` means demo mode', async () => {
    const billing = app.get(BillingService);
    expect((await billing.razorpay()).isConfigured()).toBe(true);
    expect(await billing.liveBilling()).toBe(true);
    await http()
      .put(`${URL}/payments`)
      .set(sup)
      .send({ gateway: 'none', razorpay_key_id: 'rzp_test_good' })
      .expect(200);
    expect(await billing.liveBilling()).toBe(false);
    // The secret survived the save (blank keeps it).
    expect(
      (await http().get(`${URL}/payments`).set(sup).expect(200)).body.data
        .secrets.razorpay_key_secret,
    ).toBe(true);
  });

  it('DELETE clears one secret and audits it', async () => {
    const res = await http()
      .delete(`${URL}/ai/secrets/api_key`)
      .set(sup)
      .expect(200);
    expect(res.body.data.secrets.api_key).toBe(false);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.values.max_tokens).toBe(50);
    expect((await row('ai')).secrets).toEqual({});
    const logs = await db
      .select()
      .from(audit_logs)
      .where(eq(audit_logs.action, 'integration_settings.secret_cleared'));
    expect(logs.at(-1)?.changes).toContain('api_key');
  });

  it('production refuses to start without APP_SECRET once a secret is stored', async () => {
    const svc = new IntegrationSettingsService(db);
    setEnv('NODE_ENV', 'production');
    setEnv('APP_SECRET', undefined);
    try {
      await expect(svc.onModuleInit()).rejects.toThrow(/refusing to start/);
    } finally {
      setEnv('NODE_ENV', 'test');
    }
  });

  it('rate-limits the test endpoints', async () => {
    let status = 200;
    for (let i = 0; i < 12 && status !== 429; i++)
      status = (await http().post(`${URL}/ai/test`).set(sup)).status;
    expect(status).toBe(429);
  });
});
