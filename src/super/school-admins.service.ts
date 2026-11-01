import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import { TokenService } from '../auth/token.service';
import { iso8601, modelNotFound, routeId } from '../common/http/laravel';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc } from '../db/helpers';
import { users as usersTable } from '../db/schema';
import type { schools, users } from '../db/types';

/**
 * not in legacy: School Admin accounts, managed by the Super Admin (legacy
 * only created them in seeders). A School Admin is a `users` row with role
 * `admin` and the school's `school_id`; Bodhira Direct never gets one.
 */
@Injectable()
export class SchoolAdminsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: TokenService,
  ) {}

  private readonly ofSchool = (school: schools) =>
    and(eq(usersTable.school_id, school.id), eq(usersTable.role, Role.Admin))!;

  list(school: schools) {
    return this.db.query.users.findMany({
      where: this.ofSchool(school),
      orderBy: [asc(usersTable.id)],
    });
  }

  /** The school's admin with this id; any other user 404s like a missing one. */
  async find(school: schools, raw: string) {
    const id = routeId(raw, 'User');
    const u = await this.db.query.users.findFirst({
      where: and(eq(usersTable.id, id), this.ofSchool(school)),
    });
    if (!u) throw modelNotFound('User', id);
    return u;
  }

  async create(school: schools, data: Record<string, unknown>) {
    const now = new Date();
    const [row] = await this.db
      .insert(usersTable)
      .values({
        school_id: school.id,
        name: data.name as string,
        email: data.email as string,
        phone: (data.phone as string | null) ?? null,
        role: Role.Admin,
        status: 'active',
        password: await hashPassword(data.password as string),
        created_at: now,
        updated_at: now,
      })
      .returning();
    return row;
  }

  /** name/email/phone as sent, plus a new password (which signs them out everywhere). */
  async update(user: users, data: Record<string, unknown>) {
    const fields: Record<string, unknown> = {};
    for (const k of ['name', 'email', 'phone'] as const) {
      if (k in data) fields[k] = data[k];
    }
    const newPassword =
      typeof data.password === 'string' && data.password !== '';
    if (newPassword)
      fields.password = await hashPassword(data.password as string);
    const [row] = await this.db
      .update(usersTable)
      .set({ ...fields, updated_at: new Date() })
      .where(eq(usersTable.id, user.id))
      .returning();
    // security: a reset password ends every session of the account.
    if (newPassword) await this.tokens.revokeAllForUser(user.id);
    return row;
  }

  async toggle(user: users) {
    const [row] = await this.db
      .update(usersTable)
      .set({
        status: user.status === 'active' ? 'inactive' : 'active',
        updated_at: new Date(),
      })
      .where(eq(usersTable.id, user.id))
      .returning();
    // security: a deactivated admin is signed out everywhere.
    if (row.status !== 'active') await this.tokens.revokeAllForUser(user.id);
    return row;
  }
}

export const schoolAdminResource = (u: users) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  status: u.status,
  last_login_at: iso8601(u.last_login_at),
  created_at: iso8601(u.created_at),
});
