import { ValidationFailed } from '../common/http/api.exception';
import type { Db } from '../db/db';
import type { users } from '../db/types';
import { AdminService } from './admin.service';

/** A fake Drizzle handle: the school row, per-role seat counts, and the captured update. */
function fakeDb(school: object | null, counts: Record<string, number>) {
  const updates: Record<string, unknown>[] = [];
  let role = '';
  const db = {
    query: { schools: { findFirst: () => Promise.resolve(school) } },
    // seatInfo counts `role = X` rows; the fake reads the role from a call order: teacher then student
    $count: () =>
      Promise.resolve(
        counts[(role = role === 'teacher' ? 'student' : 'teacher')],
      ),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updates.push(v);
        return { where: () => ({ returning: () => Promise.resolve([v]) }) };
      },
    }),
  };
  return { db: db as unknown as Db, updates };
}

const admin = { id: 1n, school_id: 5n, role: 'admin' } as users;

describe('AdminService seat caps (Web\\AdminController::enforceSeatCap)', () => {
  const school = { id: 5n, max_teachers: 2, max_students: 3 };

  it('refuses a teacher once max_teachers is reached, with the legacy message on `role`', async () => {
    const { db } = fakeDb(school, { teacher: 2, student: 0 });
    const svc = new AdminService(db, {} as never, {} as never);
    const err = (await svc
      .enforceSeatCap(admin, 'teacher')
      .catch((e: unknown) => e)) as ValidationFailed;
    expect(err).toBeInstanceOf(ValidationFailed);
    expect(
      (err.getResponse() as { errors: { role: string[] } }).errors.role,
    ).toEqual([
      'Teacher limit reached (2). Contact the platform admin to raise it.',
    ]);
  });

  it('refuses a student once max_students is reached', async () => {
    const { db } = fakeDb(school, { teacher: 0, student: 3 });
    const svc = new AdminService(db, {} as never, {} as never);
    const err = (await svc
      .enforceSeatCap(admin, 'student')
      .catch((e: unknown) => e)) as ValidationFailed;
    expect(
      (err.getResponse() as { errors: { role: string[] } }).errors.role,
    ).toEqual([
      'Student limit reached (3). Contact the platform admin to raise it.',
    ]);
  });

  it('allows a seat below the cap, and never limits parents', async () => {
    const { db } = fakeDb(school, { teacher: 1, student: 2 });
    const svc = new AdminService(db, {} as never, {} as never);
    await expect(svc.enforceSeatCap(admin, 'teacher')).resolves.toBeUndefined();
    await expect(svc.enforceSeatCap(admin, 'student')).resolves.toBeUndefined();
    await expect(svc.enforceSeatCap(admin, 'parent')).resolves.toBeUndefined();
  });

  it('does nothing without a school (super admin)', async () => {
    const { db } = fakeDb(null, {});
    const svc = new AdminService(db, {} as never, {} as never);
    await expect(
      svc.enforceSeatCap({ ...admin, school_id: null }, 'teacher'),
    ).resolves.toBeUndefined();
  });
});

describe('AdminService.updateUser role lock', () => {
  it('never rewrites the role of an admin account', async () => {
    const { db, updates } = fakeDb(null, {});
    const svc = new AdminService(db, {} as never, {} as never);
    const target = { id: 9n, school_id: 5n, role: 'admin' } as users;
    await svc.updateUser(admin, target, { name: 'New', role: 'student' });
    expect(updates[0]).toMatchObject({ name: 'New' });
    expect(updates[0]).not.toHaveProperty('role');
  });

  it('still lets a student become a teacher', async () => {
    const { db, updates } = fakeDb(null, {});
    const svc = new AdminService(db, {} as never, {} as never);
    const target = { id: 9n, school_id: 5n, role: 'student' } as users;
    await svc.updateUser(admin, target, { name: 'X', role: 'teacher' });
    expect(updates[0]).toMatchObject({ role: 'teacher' });
  });
});
