import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { phpJsonEncode } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { notifications } from '../db/schema';
import { JobsService } from '../jobs/jobs.service';

const USER_MORPH = 'App\\Models\\User';

/** The `notifications` job: rows with their ids fixed up front, so a retry inserts nothing twice. */
interface NotificationsJob {
  rows: { id: string; user: string }[];
  type: string;
  data: string;
  at: string;
}

/**
 * Laravel database-channel notifications (`$user->notify(...)` with via ['database']).
 * Rows match what Laravel writes, so the legacy app and the mobile API read them unchanged.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobsService,
  ) {
    jobs.handle('notifications', (d: NotificationsJob) => this.write(d));
  }

  /**
   * @param type Laravel notification class, e.g. 'LiveClassScheduled' (App\Notifications\…).
   * not in legacy: with REDIS_URL the rows are written by the worker (one job
   * per batch); without it they are written here before returning, as before.
   */
  async notifyMany(
    userIds: bigint[],
    type: string,
    data: Record<string, unknown>,
  ) {
    if (!userIds.length) return;
    const rows = userIds.map((id) => ({ id: randomUUID(), user: String(id) }));
    await this.jobs.run(
      'notifications',
      {
        rows,
        type,
        data: phpJsonEncode(data),
        at: new Date().toISOString(),
      } satisfies NotificationsJob,
      { jobId: `notifications-${rows[0].id}`, inline: 'await' },
    );
  }

  private async write(job: NotificationsJob) {
    const at = new Date(job.at);
    await this.db
      .insert(notifications)
      .values(
        job.rows.map((r) => ({
          id: r.id,
          type: `App\\Notifications\\${job.type}`,
          notifiable_type: USER_MORPH,
          notifiable_id: BigInt(r.user),
          data: job.data,
          read_at: null,
          created_at: at,
          updated_at: at,
        })),
      )
      .onConflictDoNothing({ target: notifications.id });
  }
}
