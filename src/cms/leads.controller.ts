import { Body, Controller, Inject, Logger, Post } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { Public } from '../common/decorators/auth.decorators';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { RateLimit } from '../common/decorators/rate-limit';
import { ok } from '../common/http/api-response';
import { dirtyFields } from '../common/http/eloquent';
import { laravelValidate, type Rules } from '../common/http/laravel-validator';
import { DB, type Db } from '../db/db';
import {
  contact_messages,
  demo_requests,
  newsletter_subscribers,
  student_enquiries,
} from '../db/schema';

type Data = Record<string, unknown>;
const opt = (d: Data, k: string) => (d[k] as string | null | undefined) ?? null;

/**
 * The public lead forms (legacy web routes, each `throttle:8,1`): contact
 * (PageController::contactSubmit), newsletter (newsletterSubscribe), the
 * student enquiry (enquiryStore) and "Book a Demo" (DemoController::store).
 */
@Controller('leads')
@Public()
export class LeadsController {
  private readonly logger = new Logger('Leads');

  constructor(@Inject(DB) private readonly db: Db) {}

  @Post('contact')
  @RateLimit(8)
  async contact(@Client() client: ClientInfo, @Body() body: unknown) {
    const data = await laravelValidate(this.db, body, {
      name: ['required', 'string', 'max:160'],
      email: ['required', 'email', 'max:200'],
      phone: ['nullable', 'string', 'max:40'],
      subject: ['nullable', 'string', 'max:200'],
      message: ['nullable', 'string', 'max:5000'],
    });
    const now = new Date();
    try {
      await this.db.insert(contact_messages).values({
        name: data.name as string,
        email: data.email as string,
        phone: opt(data, 'phone'),
        subject: opt(data, 'subject'),
        message: opt(data, 'message'),
        status: 'new',
        source: client.referer,
        ip_address: client.ip,
        user_agent: client.userAgent.slice(0, 320),
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      // Legacy acknowledges the visitor even when the row can't be saved.
      this.logger.warn(`Contact message not saved: ${String(e)}`);
    }
    return ok(
      null,
      'Thanks — your message has been received. We will get back to you shortly.',
    );
  }

  @Post('newsletter')
  @RateLimit(8)
  async newsletter(@Client() client: ClientInfo, @Body() body: unknown) {
    const data = await laravelValidate(this.db, body, {
      email: ['required', 'email', 'max:200'],
      name: ['nullable', 'string', 'max:160'],
    });
    const fields = {
      name: opt(data, 'name'),
      status: 'subscribed',
      ip_address: client.ip,
    };
    const now = new Date();
    try {
      const existing = await this.db.query.newsletter_subscribers.findFirst({
        where: eq(newsletter_subscribers.email, data.email as string),
        orderBy: [asc(newsletter_subscribers.id)],
      });
      if (!existing) {
        await this.db.insert(newsletter_subscribers).values({
          email: data.email as string,
          ...fields,
          created_at: now,
          updated_at: now,
        });
      } else {
        const changed = dirtyFields(existing, fields);
        if (Object.keys(changed).length) {
          await this.db
            .update(newsletter_subscribers)
            .set({ ...changed, updated_at: now })
            .where(eq(newsletter_subscribers.id, existing.id));
        }
      }
    } catch (e) {
      this.logger.warn(`Newsletter sign-up not saved: ${String(e)}`);
    }
    return ok(null, 'You are subscribed — thank you!');
  }

  @Post('enquiry')
  @RateLimit(8)
  async enquiry(@Body() body: unknown) {
    const data = await laravelValidate(this.db, body, {
      name: ['required', 'string', 'max:120'],
      email: ['required', 'email', 'max:160'],
      phone: ['required', 'string', 'max:20'],
      grade: ['nullable', 'string', 'max:20'],
      board: ['nullable', 'string', 'max:40'],
      city: ['nullable', 'string', 'max:80'],
      school_name: ['nullable', 'string', 'max:160'],
      message: ['nullable', 'string', 'max:2000'],
    });
    const now = new Date();
    await this.db.insert(student_enquiries).values({
      ...(data as { name: string; email: string; phone: string }),
      created_at: now,
      updated_at: now,
    });
    return ok(
      null,
      'Thank you! Your details have been submitted — our team will reach out to you soon.',
    );
  }

  @Post('demo')
  @RateLimit(8)
  async demo(@Body() body: unknown) {
    const type = (body as Data | null)?.type;
    const base: Rules = {
      type: ['required', 'in:school,student'],
      name: ['required', 'string', 'max:120'],
      email: ['required', 'email', 'max:160'],
      phone: ['required', 'string', 'max:20'],
      city: ['nullable', 'string', 'max:80'],
      board: ['nullable', 'string', 'max:40'],
      message: ['nullable', 'string', 'max:1000'],
    };
    const specific: Rules =
      type === 'school'
        ? {
            organization: ['required', 'string', 'max:160'],
            designation: ['nullable', 'string', 'max:80'],
            student_count: ['nullable', 'string', 'max:30'],
          }
        : {
            grade: ['required', 'string', 'max:30'],
            organization: ['nullable', 'string', 'max:160'],
          };
    const data = await laravelValidate(this.db, body, {
      ...base,
      ...specific,
    });
    const now = new Date();
    await this.db.insert(demo_requests).values({
      ...(data as {
        type: string;
        name: string;
        email: string;
        phone: string;
      }),
      status: 'new',
      created_at: now,
      updated_at: now,
    });
    return ok(
      null,
      "Thanks! We've received your details and our team will reach out to schedule your demo.",
    );
  }
}
