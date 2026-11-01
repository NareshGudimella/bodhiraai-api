import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { startsWithCi } from '../db/helpers';
import { invoices as invoicesTable, users as usersTable } from '../db/schema';
import type { invoices, plans, subscriptions, users } from '../db/types';
import { dirtyFields } from '../common/http/eloquent';
import { numberFormat, phpRound } from '../common/http/laravel';
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
  ) {}

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
        school_id: buyer.school_id,
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

  /** Mark an invoice paid, link the payment, and generate the PDF + email. */
  async markPaid(invoice: invoices, paymentId: bigint | null = null) {
    invoice = await this.save(invoice, {
      status: 'paid',
      paid_at: new Date(),
      payment_id: paymentId,
    });
    invoice = await this.generatePdf(invoice);
    await this.emailInvoice(invoice);
    const fresh = await this.db.query.invoices.findFirst({
      where: eq(invoicesTable.id, invoice.id),
    });
    if (!fresh) throw new Error('No invoices found');
    return fresh;
  }

  /**
   * Render the PDF and store it privately at the legacy path
   * (`invoices/<id>/<number>.pdf`). If that fails the invoice keeps no file,
   * like legacy without dompdf (which kept an HTML copy instead).
   */
  async generatePdf(invoice: invoices) {
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
      this.logger.error(
        `Invoice PDF failed for ${invoice.number}: ${String(e)}`,
      );
      return invoice;
    }
    return this.save(invoice, { pdf_path: relPath });
  }

  /** Email the invoice PDF as an attachment to the billing_email. */
  async emailInvoice(invoice: invoices) {
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
      this.logger.warn(
        `InvoiceService.emailInvoice failed: ${invoice.number}: ${String(e)}`,
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
