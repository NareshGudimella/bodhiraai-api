import type { Db } from '../db/db';
import type { schools } from '../db/types';
import { SuperService } from './super.service';

function fakeDb() {
  const updates: Record<string, unknown>[] = [];
  const db = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updates.push(v);
        return { where: () => ({ returning: () => Promise.resolve([v]) }) };
      },
    }),
  };
  return { db: db as unknown as Db, updates };
}

const school = {
  id: 1n,
  name: 'Old',
  plan: 'pro',
  email: null,
  phone: null,
  city: null,
  state: null,
  country: 'India',
  plan_expires_at: null,
} as unknown as schools;

describe('SuperService.updateSchool plan handling', () => {
  it('treats an empty plan as unchanged instead of writing null (plan is NOT NULL)', async () => {
    const { db, updates } = fakeDb();
    const svc = new SuperService(db, {} as never);
    await svc.updateSchool(school, { name: 'New', plan: null });
    expect(updates[0]).toMatchObject({ name: 'New' });
    expect(updates[0]).not.toHaveProperty('plan');
  });

  it('writes nothing at all when only an empty plan was sent', async () => {
    const { db, updates } = fakeDb();
    const svc = new SuperService(db, {} as never);
    await svc.updateSchool(school, { plan: null });
    expect(updates).toHaveLength(0);
  });

  it('still changes the plan when one is given', async () => {
    const { db, updates } = fakeDb();
    const svc = new SuperService(db, {} as never);
    await svc.updateSchool(school, { plan: 'starter' });
    expect(updates[0]).toMatchObject({ plan: 'starter' });
  });
});
