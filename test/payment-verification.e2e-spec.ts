process.env.TZ = 'UTC';

import { createHmac } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { asc, eq, gt, max, type AnyColumn } from 'drizzle-orm';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { phpJsonDecode } from '../src/common/http/laravel';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import { invoices, subscriptions, users } from '../src/db/schema';
import type { subscriptions as Subscription } from '../src/db/types';
import { StorageService } from '../src/storage/storage.service';

loadEnv();

/**
 * Fixed legacy bug (migration plan, Phase 5): with Razorpay keys, the paywall
 * no longer activates a plan without payment, and checkout completes only for
 * the server-side order with a valid signature, once. Razorpay's orders API is
 * mocked. Writes to student 11's subscription and one invoice; both are put
 * back afterwards.
 */
describe('Payment verification (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let token: string;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  // Not used by other suites (they run in parallel). Starts on individual_basic.
  const STUDENT = 11n;
  const SECRET = 'e2e-key-secret';
  const sign = (order: string, payment: string) =>
    createHmac('sha256', SECRET).update(`${order}|${payment}`).digest('hex');
  let saved: Subscription[];
  let maxSub: bigint;
  let maxInvoice: bigint;
  const env = [
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'STRIPE_SECRET',
    'BILLING_GATEWAY',
  ];
  const envBefore: Record<string, string | undefined> = {};

  const post = (path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const subRow = async (id: bigint) =>
    (await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, id),
    }))!;
  const maxId = async (col: AnyColumn) =>
    (await db.select({ m: max(col) }).from(col.table))[0].m as bigint | null;
  const sub = async (id: bigint) => {
    const row = await subRow(id);
    return {
      ...row,
      meta: phpJsonDecode(row.meta ?? 'null') as Record<string, unknown>,
    };
  };

  beforeAll(async () => {
    for (const k of env) envBefore[k] = process.env[k];
    process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    delete process.env.STRIPE_SECRET;
    delete process.env.BILLING_GATEWAY;
    let n = 0;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((url) => {
      if (url !== 'https://api.razorpay.com/v1/orders') {
        throw new Error('unexpected fetch');
      }
      const order = { id: `order_e2e${++n}` };
      return Promise.resolve(new Response(JSON.stringify(order)));
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    const student = (await db.query.users.findFirst({
      where: eq(users.id, STUDENT),
    }))!;
    token = await app.get(TokenService).issue(student, 'e2e', ['role:student']);
    saved = await db.query.subscriptions.findMany({
      where: eq(subscriptions.subscribable_id, STUDENT),
      orderBy: [asc(subscriptions.id)],
    });
    maxSub = (await maxId(subscriptions.id)) ?? 0n;
    maxInvoice = (await maxId(invoices.id)) ?? 0n;
  });

  afterAll(async () => {
    const issued = await db.query.invoices.findMany({
      where: gt(invoices.id, maxInvoice),
    });
    // invoices/<id>/<number>.pdf: remove the invoice's folder.
    for (const inv of issued) {
      if (inv.pdf_path)
        await rm(join(StorageService.privateDir(), dirname(inv.pdf_path)), {
          recursive: true,
          force: true,
        });
    }
    await db.delete(invoices).where(gt(invoices.id, maxInvoice));
    await db.delete(subscriptions).where(gt(subscriptions.id, maxSub));
    for (const { id, ...row } of saved)
      await db.update(subscriptions).set(row).where(eq(subscriptions.id, id));
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    await app.close();
    fetchSpy.mockRestore();
    for (const k of env) {
      if (envBefore[k] === undefined) delete process.env[k];
      else process.env[k] = envBefore[k];
    }
  });

  it('sends a paywall choice to checkout instead of activating it', async () => {
    const before = await sub(saved[0].id);
    const { body } = await post('/billing/paywall/checkout', {
      plan: 'individual_premium',
      cycle: 'yearly',
    }).expect(201);
    expect(body.data).toEqual({
      checkout: { subscription_id: Number(saved[0].id), cycle: 'yearly' },
    });
    expect(body.message).toBe(
      'Complete your payment to activate Individual Premium (yearly).',
    );
    const after = await sub(saved[0].id);
    expect(after.plan).toBe(before.plan);
    expect(after.status).toBe(before.status);
    expect(after.meta.selected_plan).toBe('individual_premium');
    expect(await db.$count(subscriptions, gt(subscriptions.id, maxSub))).toBe(
      0,
    );
  });

  it('creates the Razorpay order on the server and reuses it', async () => {
    const id = saved[0].id;
    const first = await request(app.getHttpServer())
      .get(`/api/v1/billing/checkout/${id}?cycle=yearly`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // ₹4,999 + 18% GST, in paise.
    expect(first.body.data).toEqual(
      expect.objectContaining({
        demo_mode: false,
        order_id: 'order_e2e1',
        total_paise: 589882,
      }),
    );
    const sent = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      amount: number;
    };
    expect(sent.amount).toBe(589882);
    const again = await request(app.getHttpServer())
      .get(`/api/v1/billing/checkout/${id}?cycle=yearly`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(again.body.data.order_id).toBe('order_e2e1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects completions that are not a verified payment for that order', async () => {
    const id = saved[0].id;
    const path = `/billing/checkout/${id}/complete`;
    const bad = [
      { cycle: 'yearly', demo: '1' },
      {
        cycle: 'yearly',
        razorpay_order_id: 'order_e2e1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: 'nope',
      },
      {
        cycle: 'yearly',
        razorpay_order_id: 'order_other',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: sign('order_other', 'pay_1'),
      },
      // Signed, but for the monthly price: the order was created for yearly.
      {
        cycle: 'monthly',
        razorpay_order_id: 'order_e2e1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: sign('order_e2e1', 'pay_1'),
      },
    ];
    const before = await subRow(id);
    for (const body of bad) {
      const res = await post(path, body).expect(422);
      expect(res.body).toEqual(
        expect.objectContaining({
          success: false,
          message: 'Payment could not be verified.',
          code: 'payment_unverified',
        }),
      );
    }
    expect(await subRow(id)).toEqual(before);
    expect(await db.$count(invoices, gt(invoices.id, maxInvoice))).toBe(0);
  });

  it('activates the plan for a verified payment, once', async () => {
    const id = saved[0].id;
    const body = {
      cycle: 'yearly',
      razorpay_order_id: 'order_e2e1',
      razorpay_payment_id: 'pay_ok',
      razorpay_signature: sign('order_e2e1', 'pay_ok'),
    };
    await post(`/billing/checkout/${id}/complete`, body).expect(200);
    const after = await sub(id);
    expect(after.plan).toBe('individual_premium');
    expect(after.status).toBe('active');
    expect(after.meta).toEqual(
      expect.objectContaining({
        paid_via: 'razorpay_handler',
        razorpay_order_id: 'order_e2e1',
        razorpay_payment_id: 'pay_ok',
      }),
    );
    expect(after.meta.pending_order_id).toBeUndefined();
    expect(await db.$count(invoices, gt(invoices.id, maxInvoice))).toBe(1);
    await post(`/billing/checkout/${id}/complete`, body).expect(422);
    expect(await db.$count(invoices, gt(invoices.id, maxInvoice))).toBe(1);
  });

  it('refuses demo completion when another gateway is live', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    process.env.BILLING_GATEWAY = 'stripe';
    process.env.STRIPE_SECRET = 'sk_test_e2e';
    try {
      const res = await post(`/billing/checkout/${saved[0].id}/complete`, {
        cycle: 'yearly',
        demo: '1',
      }).expect(422);
      expect(res.body.code).toBe('payment_unavailable');
    } finally {
      process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
      process.env.RAZORPAY_KEY_SECRET = SECRET;
      delete process.env.BILLING_GATEWAY;
      delete process.env.STRIPE_SECRET;
    }
  });
});
