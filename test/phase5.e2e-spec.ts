process.env.TZ = 'UTC';

import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { renderInvoicePdf } from '../src/billing/invoice-pdf';
import { numberFormat, phpJsonDecode } from '../src/common/http/laravel';
import { loadEnv } from '../src/config/env';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../src/db/db';
import { users } from '../src/db/schema';

loadEnv();

/**
 * Phase 5: billing endpoints (pricing, B2C sign-up options, paywall, checkout,
 * invoices, school billing, webhooks). Read-only apart from login tokens:
 * every write below fails validation, a guard or an unhandled event first.
 */
describe('Billing (e2e)', () => {
  let app: NestExpressApplication;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (who: string | null, path: string) => {
    const r = request(app.getHttpServer()).get(`/api/v1${path}`);
    return who ? r.set(as(who)) : r;
  };
  // A B2C student (no school) with an active premium subscription and invoice 1.
  const B2C_STUDENT = 10n;

  beforeAll(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'e2e-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    for (const [who, identifier] of [
      ['admin', 'admin@bodhira.test'],
      ['super', 'super@bodhira.test'],
    ]) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier, password: 'password', device: 'e2e' })
        .expect(200);
      tokens[who] = res.body.data.token;
    }
    const student = (await app.get<Db>(DB).query.users.findFirst({
      where: eq(users.id, B2C_STUDENT),
    }))!;
    tokens.student = await app
      .get(TokenService)
      .issue(student, 'e2e', ['role:student']);
  });

  afterAll(async () => {
    for (const who of Object.keys(tokens)) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(as(who));
    }
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    await app.close();
  });

  it('serves public pricing by audience in sort order', async () => {
    const { body } = await get(null, '/pricing').expect(200);
    const { individual, school } = body.data;
    expect(individual.map((p: { key: string }) => p.key)).toEqual([
      'individual_basic',
      'individual_premium',
    ]);
    expect(
      school.every((p: { audience: string }) => p.audience === 'school'),
    ).toBe(true);
    expect(Array.isArray(individual[0].features)).toBe(true);
    expect(typeof individual[0].is_featured).toBe('boolean');
  });

  it('serves the sign-up form data and validates in rule order', async () => {
    const { body } = await get(
      null,
      '/auth/register/student?plan=individual_premium&cycle=yearly',
    ).expect(200);
    expect(body.data.plan.key).toBe('individual_premium');
    expect(body.data.cycle).toBe('yearly');
    expect(body.data.syllabi[0]).toEqual(
      expect.objectContaining({
        board: expect.any(String),
        syllabi: expect.any(Array),
      }),
    );
    // School plans and unknown cycles fall back like legacy.
    const fallback = await get(
      null,
      '/auth/register/student?plan=school_pro&cycle=weekly',
    );
    expect(fallback.body.data).toEqual(
      expect.objectContaining({ plan: null, cycle: 'monthly' }),
    );

    const invalid = await request(app.getHttpServer())
      .post('/api/v1/auth/register/student')
      .send({})
      .expect(422);
    expect(Object.keys(invalid.body.errors)).toEqual([
      'name',
      'email',
      'password',
      'syllabus_id',
      'accept',
    ]);
    expect(invalid.body.errors.accept).toEqual([
      'The accept field must be accepted.',
    ]);
  });

  it('shows the paywall and the checkout summary for the student’s own subscription', async () => {
    const paywall = await get('student', '/billing/paywall').expect(200);
    expect(Object.keys(paywall.body.data.plans)).toEqual([
      'individual_basic',
      'individual_premium',
    ]);
    const sub = paywall.body.data.subscription;
    expect(sub.subscribable_id).toBe(Number(B2C_STUDENT));
    expect(sub).toEqual(
      expect.objectContaining({
        in_trial: false,
        days_remaining: expect.any(Number),
      }),
    );

    const { body } = await get(
      'student',
      `/billing/checkout/${sub.id}?cycle=yearly`,
    ).expect(200);
    expect(body.data).toEqual(
      expect.objectContaining({
        cycle: 'yearly',
        amount_paise: 499900,
        tax_paise: 89982,
        total_paise: 589882,
        tax_rate_pct: 18,
        gateway: 'razorpay',
      }),
    );
    expect(body.data.plan.key).toBe('individual_premium');

    // Subscription 2 belongs to another student.
    const other = await get('student', '/billing/checkout/2').expect(403);
    expect(other.body.message).toBe('Not your subscription.');
    await get('student', '/billing/checkout/99999').expect(404);
  });

  it('shows the student’s invoice; a file left on the legacy server is not found yet', async () => {
    const { body } = await get('student', '/billing/invoices/1').expect(200);
    expect(body.data.number).toBe('BDH-INV-2026-00001');
    expect(body.data.issued_at).toMatch(/\.000000Z$/);
    // Legacy PDFs move with the storage copy at cut-over.
    const dl = await get('student', '/billing/invoices/1/download').expect(404);
    expect(dl.body.message).toBe('Invoice not generated yet.');
  });

  // Not in legacy: the mobile app's invoice list.
  it('lists only the student’s own invoices, newest first', async () => {
    const { body } = await get('student', '/billing/invoices').expect(200);
    const ids = (body.data as { id: number }[]).map((i) => i.id);
    expect(ids).toContain(1);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    await get('admin', '/billing/invoices').expect(403);
  });

  it('serves school billing to the admin and every payment to the super admin', async () => {
    const admin = await get('admin', '/admin/billing').expect(200);
    expect(admin.body.data.school.id).toBe(1);
    expect(admin.body.data.pricing).toEqual({
      free: 0,
      starter: 9999,
      pro: 24999,
      enterprise: 99999,
    });
    expect(admin.body.data.gateway).toBe('razorpay');
    expect(typeof admin.body.data.students_used).toBe('number');

    const sup = await get('super', '/super/billing?page=1').expect(200);
    expect(sup.body.meta).toEqual(
      expect.objectContaining({ current_page: 1, per_page: 30 }),
    );
  });

  it('keeps billing routes to their roles', async () => {
    await get('admin', '/billing/paywall').expect(403);
    await get('student', '/admin/billing').expect(403);
    await get('admin', '/super/billing').expect(403);
    await get(null, '/billing/paywall').expect(401);
  });

  it('serves webhooks at the legacy URLs with raw-body signatures', async () => {
    const payload = JSON.stringify({ event: 'refund.created', payload: {} });
    const sig = createHmac('sha256', 'e2e-secret')
      .update(payload)
      .digest('hex');
    const post = (path: string, signature: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', signature)
        .send(payload);
    await post('/webhooks/razorpay', sig).expect(200, { ok: true });
    await post('/webhooks/razorpay', 'bad').expect(400, {
      ok: false,
      error: 'Invalid Razorpay signature',
    });
    // Re-serialising the JSON would break the signature: spaces must survive.
    const spaced = '{ "event" : "refund.created" }';
    await request(app.getHttpServer())
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set(
        'X-Razorpay-Signature',
        createHmac('sha256', 'e2e-secret').update(spaced).digest('hex'),
      )
      .send(spaced)
      .expect(200);
    await post('/api/v1/webhooks/razorpay', sig).expect(404);
  });

  it('formats like PHP and renders the invoice PDF', async () => {
    expect(numberFormat(5898.82, 2)).toBe('5,898.82');
    expect(numberFormat(1234567.5)).toBe('1,234,568');
    expect(phpJsonDecode('{"a":{},"b":{"0":1,"1":2},"c":{"1":1}}')).toEqual({
      a: [],
      b: [1, 2],
      c: { 1: 1 },
    });
    const pdf = await renderInvoicePdf(
      {
        number: 'BDH-INV-2026-00009',
        status: 'paid',
        paid_at: new Date(),
        issued_at: new Date(),
        billing_name: 'A',
        billing_email: 'a@example.com',
        billing_address: null,
        billing_gstin: null,
        plan_name: 'Individual Basic',
        cycle: 'monthly',
        currency: 'INR',
        amount_paise: 29900n,
        tax_paise: 5382n,
        total_paise: 35282n,
        tax_rate_bps: 1800,
      } as never,
      null,
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
