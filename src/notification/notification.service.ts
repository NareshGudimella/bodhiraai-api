import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { phpJsonEncode } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { notifications } from '../db/schema';

const USER_MORPH = 'App\\Models\\User';

/**
 * Laravel database-channel notifications (`$user->notify(...)` with via ['database']).
 * Rows match what Laravel writes, so the legacy app and the mobile API read them unchanged.
 */
@Injectable()
export class NotificationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** @param type Laravel notification class, e.g. 'LiveClassScheduled' (App\Notifications\…). */
  async notifyMany(
    userIds: bigint[],
    type: string,
    data: Record<string, unknown>,
  ) {
    if (!userIds.length) return;
    const now = new Date();
    const json = phpJsonEncode(data);
    await this.db.insert(notifications).values(
      userIds.map((id) => ({
        id: randomUUID(),
        type: `App\\Notifications\\${type}`,
        notifiable_type: USER_MORPH,
        notifiable_id: id,
        data: json,
        read_at: null,
        created_at: now,
        updated_at: now,
      })),
    );
  }
}
