import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { schoolOf } from '../common/direct-school';
import { startsWithCi } from '../db/helpers';
import { invoices as invoicesTable, users as usersTable } from '../db/schema';
import type { invoices, plans, subscriptions, users } from '../db/types';
import { dirtyFields } from '../common/http/eloquent';
import { numberFormat, phpRound } from '../common/http/laravel';
import { JobsService, logSafe } from '../jobs/jobs.service';
import { MailService } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { TAX_RATE_BPS, pricePaiseFor } from './billing.constants';
import { mjY, renderInvoicePdf } from './invoice-pdf';

/** Port of App\Services\InvoiceService. */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger('InvoiceService');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly mail: MailService,
    private readonly jobs: JobsService,
  ) {
    jobs.handle('invoice', (d: { invoice: string }, { final }) =>
      this.deliver(BigInt(d.invoice), !final),
    );
  }

  /** Invoice::nextNumber(): BDH-INV-<year>-<5-digit sequence>. */
  async nextNumber() {
    const prefix = `BDH-INV-${new Date().getUTCFullYear()}-`;
    const last = await this.db.query.invoices.findFirst({
      where: startsWithCi(invoicesTable.number, prefix),
      orderBy: [desc(invoicesTable.id)],
      columns: { number: true },
    });
    const seq = last
      ? (parseInt(last.number.slice(prefix.length), 10) || 0) + 1
      : 1;
    return prefix + String(seq).padStart(5, '0');
  }

  /** Create a pending Invoice row from a paid Subscription. */
  async issue(
    subscription: subscriptions,
    plan: plans,
    cycle: string,
    buyer: users,
  ) {
    const base = pricePaiseFor(plan, cycle); // pre-tax, in paise
    const tax = phpRound((base * TAX_RATE_BPS) / 10000);
    const now = new Date();
    const [row] = await this.db
      .insert(invoicesTable)
      .values({
        number: await this.nextNumber(),
        user_id: buyer.id,
        // not in legacy: a Bodhira Direct buyer's invoice has no school, like B2C.
        school_id: await schoolOf(this.db, buyer),
        subscription_id: subscription.id,
        plan_key: plan.key,
        plan_name: plan.name,
        cycle,
        amount_paise: BigInt(base),
        tax_rate_bps: TAX_RATE_BPS,
        tax_paise: BigInt(tax),
        total_paise: BigInt(base + tax),
        currency: 'INR',
        status: 'pending',
        issued_at: now,
        billing_name: buyer.name,
        billing_email: buyer.email,
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /**
   * Mark an invoice paid, link the payment, and generate the PDF + email.
   * not in legacy: with REDIS_URL the PDF and email are an `invoice` job, so
   * the returned row has no `pdf_path` yet (the download renders it on demand
   * meanwhile); without it they happen here, before returning, as before.
   */
  async markPaid(invoice: invoices, paymentId: bigint | null = null) {
    invoice = await this.save(invoice, {
      status: 'paid',
      paid_at: new Date(),
      payment_id: paymentId,
    });
    await this.jobs.run(
      'invoice',
      { invoice: String(invoice.id) },
      { jobId: `invoice-${invoice.id}`, inline: 'await' },
    );
    const fresh = await this.db.query.invoices.findFirst({
      where: eq(invoicesTable.id, invoice.id),
    });
    if (!fresh) throw new Error('No invoices found');
    return fresh;
  }

  /**
   * The `invoice` job: the PDF, then the email, each skipped once done (so a
   * retry repeats neither). `strict` (every queued attempt but the last)
   * throws on failure so the job is retried; otherwise a failed PDF still
   * sends the email without it and a failed email is logged, like legacy.
   */
  async deliver(id: bigint, strict = false) {
    let invoice = await this.db.query.invoices.findFirst({
      where: eq(invoicesTable.id, id),
    });
    if (!invoice) return;
    if (!invoice.pdf_path) invoice = await this.generatePdf(invoice, strict);
    if (!invoice.email_sent_at) await this.emailInvoice(invoice, strict);
  }

  /**
   * Render the PDF and store it privately at the legacy path
   * (`invoices/<id>/<number>.pdf`). If that fails the invoice keeps no file,
   * like legacy without dompdf (which kept an HTML copy instead).
   */
  async generatePdf(invoice: invoices, strict = false) {
    const user = invoice.user_id
      ? ((await this.db.query.users.findFirst({
          where: eq(usersTable.id, invoice.user_id),
          columns: { name: true, email: true },
        })) ?? null)
      : null;
    const relPath = `invoices/${invoice.id}/${invoice.number}.pdf`;
    try {
      const pdf = await renderInvoicePdf(invoice, user);
      await this.storage.putPrivate(relPath, pdf, 'application/pdf');
    } catch (e) {
      if (strict) throw e;
      this.logger.error(
        `Invoice PDF failed for ${invoice.number}: ${String(e)}`,
      );
      return invoice;
    }
    return this.save(invoice, { pdf_path: relPath });
  }

  /** Email the invoice PDF as an attachment to the billing_email. */
  async emailInvoice(invoice: invoices, strict = false) {
    if (!invoice.billing_email) return;
    try {
      const pdf = invoice.pdf_path
        ? await this.storage.getPrivate(invoice.pdf_path)
        : null;
      await this.mail.send({
        to: {
          address: invoice.billing_email,
          name: invoice.billing_name || null,
        },
        subject: `Your Bodhira invoice · ${invoice.number}`,
        text: this.plainTextBody(invoice),
        attachments: pdf
          ? [
              {
                filename: `${invoice.number}.pdf`,
                content: pdf,
                contentType: 'application/pdf',
              },
            ]
          : [],
      });
      await this.save(invoice, { email_sent_at: new Date() });
    } catch (e) {
      if (strict) throw e;
      this.logger.warn(
        `InvoiceService.emailInvoice failed: ${invoice.number}: ${logSafe(e)}`,
      );
    }
  }

  private plainTextBody(invoice: invoices) {
    const total = numberFormat(Number(invoice.total_paise) / 100, 2);
    return [
      `Hi ${invoice.billing_name ?? ''},`,
      '',
      `Thanks for your payment! Your invoice ${invoice.number} for ₹${total} is attached.`,
      '',
      `Plan: ${invoice.plan_name} (${invoice.cycle})`,
      `Issued: ${mjY(invoice.issued_at)}`,
      '',
      'You can also view it any time in your Bodhira account.',
      '',
      '— The Bodhira team',
    ].join('\n');
  }

  /** `$invoice->forceFill($fields)->save()`: writes changed columns only. */
  private async save(invoice: invoices, fields: Partial<invoices>) {
    const changed = dirtyFields(invoice, fields);
    if (!Object.keys(changed).length) return invoice;
    const now = new Date();
    await this.db
      .update(invoicesTable)
      .set({ ...changed, updated_at: now })
      .where(eq(invoicesTable.id, invoice.id));
    return { ...invoice, ...changed, updated_at: now } as invoices;
  }
}
