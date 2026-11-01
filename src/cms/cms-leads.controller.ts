import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Query,
  Res,
} from '@nestjs/common';
import { and, eq, asc } from 'drizzle-orm';
import type { Response } from 'express';
import { Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { dirtyFields, toModel } from '../common/http/eloquent';
import { modelNotFound, routeId } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { pageFrom, pageMeta } from '../common/http/paginate';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { myDesc } from '../db/helpers';
import {
  contact_messages,
  demo_requests,
  newsletter_subscribers,
} from '../db/schema';
import { sendCsv } from './csv';

const TYPES = ['school', 'student'];
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const TABLES = { demo_requests, contact_messages, newsletter_subscribers };

/** Port of App\Http\Controllers\Cms\LeadController: demo requests, contact messages, newsletter. */
@Controller('cms')
@Roles(Role.SuperAdmin, Role.WebAdmin)
export class CmsLeadsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async find<T>(
    table: keyof typeof TABLES,
    model: string,
    raw: string,
  ): Promise<T & { id: bigint }> {
    const id = routeId(raw, `Cms\\${model}`);
    const t = TABLES[table];
    const [row] = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) throw modelNotFound(`Cms\\${model}`, id);
    return row as unknown as T & { id: bigint };
  }

  private async setStatus(
    table: 'demo_requests' | 'contact_messages',
    row: { id: bigint; status: string },
    status: string,
  ) {
    const changed = dirtyFields(row, { status });
    if (!Object.keys(changed).length) return;
    const t = TABLES[table];
    await this.db
      .update(t)
      .set({ ...changed, updated_at: new Date() })
      .where(eq(t.id, row.id));
  }

  // ---- Demo requests -------------------------------------------------

  @Get('demos')
  async demos(
    @Query('type') rawType: unknown,
    @Query('status') status: unknown,
    @Query('page') rawPage: unknown,
  ) {
    const type = TYPES.includes(rawType as string)
      ? (rawType as string)
      : 'school';
    const where = and(
      eq(demo_requests.type, type),
      str(status) ? eq(demo_requests.status, str(status)!) : undefined,
    );
    const page = pageFrom(rawPage);
    const [total, rows, school, student] = await Promise.all([
      this.db.$count(demo_requests, where),
      this.db.query.demo_requests.findMany({
        where,
        orderBy: [myDesc(demo_requests.created_at), asc(demo_requests.id)],
        offset: (page - 1) * 20,
        limit: 20,
      }),
      this.db.$count(demo_requests, eq(demo_requests.type, 'school')),
      this.db.$count(demo_requests, eq(demo_requests.type, 'student')),
    ]);
    return ok(
      {
        demos: rows.map((d) => toModel('demo_requests', d)),
        type,
        counts: { school, student },
      },
      null,
      pageMeta(page, 20, total),
    );
  }

  @Patch('demos/:demo')
  async demoStatus(@Param('demo') raw: string, @Body() body: unknown) {
    const demo = await this.find<{ status: string }>(
      'demo_requests',
      'DemoRequest',
      raw,
    );
    const data = await laravelValidate(this.db, body, {
      status: ['required', 'in:new,contacted,scheduled,closed'],
    });
    await this.setStatus('demo_requests', demo, data.status as string);
    return ok(null, 'Demo request updated.');
  }

  @Delete('demos/:demo')
  async demoDestroy(@Param('demo') raw: string) {
    const demo = await this.find('demo_requests', 'DemoRequest', raw);
    await this.db.delete(demo_requests).where(eq(demo_requests.id, demo.id));
    return ok(null, 'Demo request deleted.');
  }

  @Get('demos/export')
  async demosExport(@Query('type') rawType: unknown, @Res() res: Response) {
    const type = TYPES.includes(rawType as string) ? (rawType as string) : null;
    const rows = await this.db.query.demo_requests.findMany({
      where: type ? eq(demo_requests.type, type) : undefined,
      orderBy: [myDesc(demo_requests.created_at), asc(demo_requests.id)],
    });
    sendCsv(
      res,
      `${type ?? 'all'}-demo-requests.csv`,
      [
        'Type',
        'Name',
        'Email',
        'Phone',
        'City',
        'Board',
        'Organization',
        'Designation',
        'Students',
        'Class',
        'Message',
        'Status',
        'Received',
      ],
      rows.map((d) => [
        d.type,
        d.name,
        d.email,
        d.phone,
        d.city,
        d.board,
        d.organization,
        d.designation,
        d.student_count,
        d.grade,
        d.message,
        d.status,
        d.created_at,
      ]),
    );
  }

  // ---- Contact messages ----------------------------------------------

  @Get('contacts')
  async contacts(
    @Query('status') status: unknown,
    @Query('page') rawPage: unknown,
  ) {
    const where = str(status)
      ? eq(contact_messages.status, str(status)!)
      : undefined;
    const page = pageFrom(rawPage);
    const [total, rows] = await Promise.all([
      this.db.$count(contact_messages, where),
      this.db.query.contact_messages.findMany({
        where,
        orderBy: [
          myDesc(contact_messages.created_at),
          asc(contact_messages.id),
        ],
        offset: (page - 1) * 20,
        limit: 20,
      }),
    ]);
    return ok(
      rows.map((m) => toModel('contact_messages', m)),
      null,
      pageMeta(page, 20, total),
    );
  }

  @Patch('contacts/:message')
  async contactStatus(@Param('message') raw: string, @Body() body: unknown) {
    const message = await this.find<{ status: string }>(
      'contact_messages',
      'ContactMessage',
      raw,
    );
    const data = await laravelValidate(this.db, body, {
      status: ['required', 'in:new,read,replied,archived'],
    });
    await this.setStatus('contact_messages', message, data.status as string);
    return ok(null, 'Message status updated.');
  }

  @Delete('contacts/:message')
  async contactDestroy(@Param('message') raw: string) {
    const message = await this.find('contact_messages', 'ContactMessage', raw);
    await this.db
      .delete(contact_messages)
      .where(eq(contact_messages.id, message.id));
    return ok(null, 'Message deleted.');
  }

  @Get('contacts/export')
  async contactsExport(@Res() res: Response) {
    const rows = await this.db.query.contact_messages.findMany({
      orderBy: [myDesc(contact_messages.created_at), asc(contact_messages.id)],
    });
    sendCsv(
      res,
      'contact-messages.csv',
      ['Name', 'Email', 'Phone', 'Subject', 'Message', 'Status', 'Received'],
      rows.map((m) => [
        m.name,
        m.email,
        m.phone,
        m.subject,
        m.message,
        m.status,
        m.created_at,
      ]),
    );
  }

  // ---- Newsletter ----------------------------------------------------

  @Get('subscribers')
  async subscribers(
    @Query('status') status: unknown,
    @Query('page') rawPage: unknown,
  ) {
    const where = str(status)
      ? eq(newsletter_subscribers.status, str(status)!)
      : undefined;
    const page = pageFrom(rawPage);
    const [total, rows] = await Promise.all([
      this.db.$count(newsletter_subscribers, where),
      this.db.query.newsletter_subscribers.findMany({
        where,
        orderBy: [
          myDesc(newsletter_subscribers.created_at),
          asc(newsletter_subscribers.id),
        ],
        offset: (page - 1) * 30,
        limit: 30,
      }),
    ]);
    return ok(
      rows.map((s) => toModel('newsletter_subscribers', s)),
      null,
      pageMeta(page, 30, total),
    );
  }

  @Delete('subscribers/:subscriber')
  async subscriberDestroy(@Param('subscriber') raw: string) {
    const s = await this.find(
      'newsletter_subscribers',
      'NewsletterSubscriber',
      raw,
    );
    await this.db
      .delete(newsletter_subscribers)
      .where(eq(newsletter_subscribers.id, s.id));
    return ok(null, 'Subscriber removed.');
  }

  @Get('subscribers/export')
  async subscribersExport(@Res() res: Response) {
    const rows = await this.db.query.newsletter_subscribers.findMany({
      orderBy: [
        myDesc(newsletter_subscribers.created_at),
        asc(newsletter_subscribers.id),
      ],
    });
    sendCsv(
      res,
      'newsletter-subscribers.csv',
      ['Email', 'Name', 'Status', 'Subscribed'],
      rows.map((s) => [s.email, s.name, s.status, s.created_at]),
    );
  }
}
