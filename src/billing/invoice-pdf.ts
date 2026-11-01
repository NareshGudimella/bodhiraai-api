import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import type { invoices } from '../db/types';
import { numberFormat } from '../common/http/laravel';

/**
 * resources/views/billing/invoice-pdf.blade.php, drawn with pdfkit on A4 in the
 * positions dompdf renders it. DejaVu fonts as in dompdf; where legacy asks for
 * Poppins (brand, title, total) dompdf falls back to a serif, so this uses
 * DejaVu Serif, which also has the ₹ glyph dompdf printed as "?".
 */

const FONTS = resolve(__dirname, '../../assets/fonts');
const C = {
  ink: '#1A0A0C',
  brand: '#2A0E13',
  gold: '#C49560',
  muted: '#6B4A38',
  box: '#FAEAD0',
  line: '#E8D4B8',
  head: '#FDF4E8',
};
const PILL = {
  paid: { bg: '#ECFDF5', fg: '#1A7A48' },
  pending: { bg: '#FFF8ED', fg: '#C47A20' },
  other: { bg: '#FEF2F2', fg: '#C42020' },
};

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** Carbon format('M j, Y'). */
export const mjY = (d: Date) =>
  `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const money = (paise: bigint | number) =>
  `₹${numberFormat(Number(paise) / 100, 2)}`;

export interface InvoiceParty {
  name: string | null;
  email: string | null;
}

export function renderInvoicePdf(
  invoice: invoices,
  user: InvoiceParty | null,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: { Title: `Invoice ${invoice.number}`, Producer: 'Bodhira.ai' },
  });
  doc.registerFont('sans', `${FONTS}/DejaVuSans.ttf`);
  doc.registerFont('sans-bold', `${FONTS}/DejaVuSans-Bold.ttf`);
  doc.registerFont('mono', `${FONTS}/DejaVuSansMono.ttf`);
  doc.registerFont('serif', `${FONTS}/DejaVuSerif.ttf`);
  doc.registerFont('serif-bold', `${FONTS}/DejaVuSerif-Bold.ttf`);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((ok, fail) => {
    doc.on('end', () => ok(Buffer.concat(chunks)));
    doc.on('error', fail);
  });

  const L = 60;
  const R = 535;
  const W = R - L;
  const text = (
    s: string,
    x: number,
    y: number,
    opts: PDFKit.Mixins.TextOptions & {
      font?: string;
      size?: number;
      color?: string;
    } = {},
  ) => {
    const { font = 'sans', size = 11, color = C.ink, ...rest } = opts;
    doc
      .font(font)
      .fontSize(size)
      .fillColor(color)
      .text(s, x, y, {
        lineBreak: false,
        ...rest,
      });
  };

  // Header: brand and address on the left, title, number and status on the right.
  doc.font('serif').fontSize(24).fillColor(C.brand).text('Bodhira.ai ', L, 50, {
    continued: true,
    lineBreak: false,
  });
  doc.fillColor(C.gold).text('LMS', { lineBreak: false });
  text('AI-POWERED EDTECH', L, 83, {
    size: 7,
    color: C.muted,
    characterSpacing: 1.5,
  });
  [
    'Bodhira.ai Education Pvt. Ltd.',
    'Hyderabad, Telangana, India',
    'hello@bodhira.com',
  ].forEach((line, i) =>
    text(line, L, 112 + i * 15, { size: 7, color: C.muted }),
  );

  text('INVOICE', L, 50, { font: 'serif', size: 22, width: W, align: 'right' });
  text(invoice.number, L, 85, {
    font: 'mono',
    size: 8.5,
    color: C.muted,
    width: W,
    align: 'right',
  });

  const pill =
    invoice.status === 'paid'
      ? {
          ...PILL.paid,
          label: `✓ Paid · ${invoice.paid_at ? mjY(invoice.paid_at) : ''}`,
        }
      : invoice.status === 'pending'
        ? { ...PILL.pending, label: 'Pending' }
        : { ...PILL.other, label: ucfirst(invoice.status) };
  doc.font('sans-bold').fontSize(7);
  const pw = doc.widthOfString(pill.label) + 16;
  doc.roundedRect(R - pw, 103, pw, 14, 7).fill(pill.bg);
  text(pill.label, R - pw + 8, 106.5, {
    font: 'sans-bold',
    size: 7,
    color: pill.fg,
  });
  text(`Issued · ${mjY(invoice.issued_at)}`, L, 128, {
    size: 7,
    color: C.muted,
    width: W,
    align: 'right',
  });

  // Billed-to and subscription boxes.
  const boxY = 180;
  const boxW = (W - 14) / 2;
  const box = (x: number, label: string, title: string, lines: string[]) => {
    doc.roundedRect(x, boxY, boxW, 96, 6).fill(C.box);
    text(label, x + 13, boxY + 12, {
      font: 'sans-bold',
      size: 6.5,
      color: C.muted,
      characterSpacing: 1,
    });
    text(title, x + 13, boxY + 30, { font: 'sans-bold', size: 8.5 });
    lines.forEach((line, i) =>
      text(line, x + 13, boxY + 50 + i * 18, { size: 8.5 }),
    );
  };
  const billed = [invoice.billing_email || user?.email || ''];
  if (invoice.billing_address) billed.push(invoice.billing_address);
  if (invoice.billing_gstin) billed.push(`GSTIN: ${invoice.billing_gstin}`);
  box(L, 'BILLED TO', invoice.billing_name || user?.name || '', billed);
  box(L + boxW + 14, 'SUBSCRIPTION', invoice.plan_name, [
    `Billing cycle: ${ucfirst(invoice.cycle)}`,
    `Currency: ${invoice.currency}`,
  ]);

  // Line items.
  doc.rect(L, 299, W, 27).fill(C.brand);
  text('Description', L + 9, 309, {
    font: 'sans-bold',
    size: 7,
    color: C.head,
    characterSpacing: 1,
  });
  text('Amount', L, 309, {
    font: 'sans-bold',
    size: 7,
    color: C.head,
    characterSpacing: 1,
    width: W - 9,
    align: 'right',
  });
  doc
    .font('sans-bold')
    .fontSize(8.5)
    .fillColor(C.ink)
    .text(invoice.plan_name, L + 9, 342, {
      continued: true,
      lineBreak: false,
    });
  doc
    .font('sans')
    .text(` — ${ucfirst(invoice.cycle)} subscription`, { lineBreak: false });
  text(money(invoice.amount_paise), L, 342, {
    font: 'mono',
    size: 8.5,
    width: W - 9,
    align: 'right',
  });
  doc
    .moveTo(L, 365)
    .lineTo(R, 365)
    .lineWidth(0.75)
    .strokeColor(C.line)
    .stroke();

  // Totals.
  const TL = 354;
  const TW = R - TL;
  const row = (label: string, value: string, y: number, total = false) => {
    text(
      label,
      TL,
      y,
      total
        ? { font: 'serif', size: 10, color: C.brand }
        : { size: 8.5, color: C.muted },
    );
    text(
      value,
      TL,
      y - 4,
      total
        ? { font: 'serif', size: 10, color: C.brand, width: TW, align: 'right' }
        : { font: 'mono', size: 8.5, width: TW, align: 'right' },
    );
  };
  row('Subtotal', money(invoice.amount_paise), 389);
  row(
    `GST (${numberFormat(invoice.tax_rate_bps / 100, 0)}%)`,
    money(invoice.tax_paise),
    415,
  );
  doc
    .moveTo(TL, 428)
    .lineTo(R, 428)
    .lineWidth(1.5)
    .strokeColor(C.brand)
    .stroke();
  row('Total', money(invoice.total_paise), 444, true);

  // Footer.
  doc
    .moveTo(L, 484)
    .lineTo(R, 484)
    .lineWidth(0.75)
    .dash(2, { space: 2 })
    .strokeColor(C.line)
    .stroke()
    .undash();
  text(
    'Thank you for choosing Bodhira.ai. This is a system-generated invoice.',
    L,
    504,
    {
      size: 7,
      color: C.muted,
      width: W,
      align: 'center',
    },
  );
  doc.font('sans').fontSize(7);
  const pre = 'Reply to ';
  const strong = 'hello@bodhira.com';
  const post = ' for any billing question.';
  const lineW =
    doc.widthOfString(pre + post) + doc.font('sans-bold').widthOfString(strong);
  doc
    .font('sans')
    .fillColor(C.muted)
    .text(pre, L + (W - lineW) / 2, 520, { continued: true, lineBreak: false });
  doc.font('sans-bold').text(strong, { continued: true, lineBreak: false });
  doc.font('sans').text(post, { lineBreak: false });

  doc.end();
  return done;
}
