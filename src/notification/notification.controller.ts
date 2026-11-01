import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, eq, isNull, asc } from 'drizzle-orm';
import { CurrentUser } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { iso8601, jsonCast, modelNotFoundClass } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { myDesc } from '../db/helpers';
import { notifications } from '../db/schema';
import type { users } from '../db/types';

const USER_MORPH = 'App\\Models\\User';
const PER_PAGE = 25;

type NotificationData = {
  type?: string;
  icon?: string;
  title?: string;
  body?: string;
  meta?: unknown;
  url?: string;
};

/** /api/v1/me/notifications — port of Api\V1\Shared\NotificationApiController (any signed-in user). */
@Controller('me/notifications')
export class NotificationController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private mine(user: users) {
    return and(
      eq(notifications.notifiable_type, USER_MORPH),
      eq(notifications.notifiable_id, user.id),
    );
  }

  /** `$user->notifications()->paginate(25)`: newest first, `?page=` like Laravel. */
  @Get()
  async index(@CurrentUser() user: users, @Query('page') rawPage?: string) {
    const page =
      /^\d+$/.test(rawPage ?? '') && Number(rawPage) > 0 ? Number(rawPage) : 1;
    const where = this.mine(user);
    const [rows, total, unread] = await Promise.all([
      this.db.query.notifications.findMany({
        where,
        orderBy: [myDesc(notifications.created_at), asc(notifications.id)],
        offset: (page - 1) * PER_PAGE,
        limit: PER_PAGE,
      }),
      this.db.$count(notifications, where),
      this.db.$count(notifications, and(where, isNull(notifications.read_at))),
    ]);
    return ok(
      rows.map((n) => {
        const d = jsonCast<NotificationData>(n.data) ?? {};
        return {
          id: n.id,
          type: d.type ?? null,
          icon: d.icon ?? '🔔',
          title: d.title ?? null,
          body: d.body ?? null,
          meta: d.meta ?? [],
          url: d.url ?? null,
          read_at: iso8601(n.read_at),
          created_at: iso8601(n.created_at),
        };
      }),
      null,
      {
        current_page: page,
        per_page: PER_PAGE,
        total,
        last_page: Math.max(1, Math.ceil(total / PER_PAGE)),
        unread_count: unread,
      },
    );
  }

  @Post('read-all')
  @HttpCode(200)
  async markAllRead(@CurrentUser() user: users) {
    const now = new Date();
    const { rowCount } = await this.db
      .update(notifications)
      .set({ read_at: now, updated_at: now })
      .where(and(this.mine(user), isNull(notifications.read_at)));
    return ok({ marked: rowCount ?? 0 }, 'All read.');
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(@CurrentUser() user: users, @Param('id') id: string) {
    const n = await this.db.query.notifications.findFirst({
      where: and(this.mine(user), eq(notifications.id, id)),
    });
    if (!n)
      throw modelNotFoundClass(
        'Illuminate\\Notifications\\DatabaseNotification',
      );
    if (!n.read_at) {
      const now = new Date();
      await this.db
        .update(notifications)
        .set({ read_at: now, updated_at: now })
        .where(eq(notifications.id, id));
    }
    return ok(null, 'Notification marked read.');
  }
}
