import { Inject, Injectable } from '@nestjs/common';
import type { ClientInfo } from '../common/decorators/client.decorator';
import { phpJsonEncode } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { audit_logs } from '../db/schema';
import type { users } from '../db/types';

/** Port of App\Support\Audit::log(): one audit_logs row per CMS change. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async log(
    user: users | null,
    client: ClientInfo,
    action: string,
    subject: { type: string; id: bigint } | null = null,
    changes: Record<string, unknown> | null = null,
  ) {
    await this.db.insert(audit_logs).values({
      user_id: user?.id ?? null,
      school_id: user?.school_id ?? null,
      action,
      subject_type: subject?.type ?? null,
      subject_id: subject?.id ?? null,
      changes: changes === null ? null : phpJsonEncode(changes),
      ip_address: client.ip,
      user_agent: client.userAgent.slice(0, 240),
      created_at: new Date(),
    });
  }
}

/** Morph class names of the CMS models (`$subject::class`). */
export const CMS_MODEL = (name: string) => `App\\Models\\Cms\\${name}`;
