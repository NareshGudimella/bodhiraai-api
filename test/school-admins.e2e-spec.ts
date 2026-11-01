process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, inArray, or } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import { personal_access_tokens, schools, users } from '../src/db/schema';
import type { schools as School } from '../src/db/types';

loadEnv();

const tag = randomBytes(3).toString('hex');

type Envelope<T = unknown> = {
  success: boolean;
  message?: string;
  code?: string;
  data: T;
  errors?: Record<string, string[]>;
};
type AdminRow = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  last_login_at: string | null;
  created_at: string;
};

/**
 * not in legacy: the Super Admin's School Admin accounts
 * (`/super/schools/:school/admins`). Creates its own schools and users and
 * removes them (and every user created through the API) afterwards.
 */
describe('School Admin accounts (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let tokens: TokenService;
  let direct: School;
  let schoolA: School;
  let schoolB: School;
  const createdSchools: bigint[] = [];
  const t: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const email = (k: string) => `sa-${tag}-${k}@bodhira.test`;
  const now = new Date();
  const stamps = { created_at: now, updated_at: now };
  const base = (s: School) => `/api/v1/super/schools/${s.id}/admins`;

  async function mkUser(who: string, role: string, schoolId: bigint | null) {
    const [user] = await db
      .insert(users)
      .values({
        name: `SA ${who}`,
        email: email(who),
        password: 'x',
        role,
        school_id: schoolId,
        status: 'active',
        ...stamps,
      })
      .returning();
    t[who] = await tokens.issue(user, 'e2e', [`role:${role}`]);
    return user;
  }

  async function mkSchool(name: string) {
    const [s] = await db
      .insert(schools)
      .values({
        name: `${name} ${tag}`,
        slug: `sa-${name.toLowerCase()}-${tag}`,
        code: `SA${name.slice(0, 2).toUpperCase()}${tag.toUpperCase()}`,
        ...stamps,
      })
      .returning();
    createdSchools.push(s.id);
    return s;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    tokens = app.get(TokenService);

    const row = await db.query.schools.findFirst({
      where: eq(schools.is_direct, true),
    });
    if (!row)
      throw new Error('Bodhira Direct is missing: run npm run db:migrate');
    direct = row;
    schoolA = await mkSchool('Alpha');
    schoolB = await mkSchool('Beta');
    await mkUser('super', 'super_admin', null);
    await mkUser('adminA', 'admin', schoolA.id);
    await mkUser('teacherA', 'teacher', schoolA.id);
    await mkUser('studentA', 'student', schoolA.id);
  });

  afterAll(async () => {
    if (db) {
      // Every user of the test schools, plus the super admin (made by this file).
      const mine = await db
        .select({ id: users.id })
        .from(users)
        .where(
          or(
            inArray(users.school_id, createdSchools),
            eq(users.email, email('super')),
          ),
        );
      const ids = mine.map((r) => r.id);
      if (ids.length) {
        await db
          .delete(personal_access_tokens)
          .where(inArray(personal_access_tokens.tokenable_id, ids));
        await db.delete(users).where(inArray(users.id, ids));
      }
      if (createdSchools.length)
        await db.delete(schools).where(inArray(schools.id, createdSchools));
    }
    await app?.close();
  });

  const login = (identifier: string, password: string) =>
    http()
      .post('/api/v1/auth/login')
      .send({ identifier, password, device: 'e2e' });

  let created: AdminRow;

  it('creates a School Admin who can sign in', async () => {
    const res = await http()
      .post(base(schoolA))
      .set(as('super'))
      .send({
        name: '  New Admin  ',
        email: email('new'),
        phone: `+91${tag}01`,
        password: 'secret-123',
      })
      .expect(201);
    const body = res.body as Envelope<AdminRow>;
    expect(body.message).toBe('School Admin created.');
    created = body.data;
    expect(created).toMatchObject({
      name: 'New Admin',
      email: email('new'),
      status: 'active',
      last_login_at: null,
    });
    const row = await db.query.users.findFirst({
      where: eq(users.id, BigInt(created.id)),
    });
    expect(row).toMatchObject({ role: 'admin', school_id: schoolA.id });

    const res2 = await login(email('new'), 'secret-123').expect(200);
    const me = await http()
      .get('/api/v1/admin/home')
      .set({
        Authorization: `Bearer ${(res2.body as Envelope<{ token: string }>).data.token}`,
      });
    expect(me.status).toBe(200);
  });

  it('lists the school admins only', async () => {
    const res = await http().get(base(schoolA)).set(as('super')).expect(200);
    const list = (res.body as Envelope<AdminRow[]>).data;
    expect(list.map((a) => a.email)).toEqual([email('adminA'), email('new')]);
    expect(list[1].last_login_at).not.toBeNull();
    expect(Object.keys(list[0]).sort()).toEqual(
      [
        'created_at',
        'email',
        'id',
        'last_login_at',
        'name',
        'phone',
        'status',
      ].sort(),
    );
    const other = await http().get(base(schoolB)).set(as('super')).expect(200);
    expect((other.body as Envelope<AdminRow[]>).data).toEqual([]);
  });

  it('validates like the user forms', async () => {
    const res = await http()
      .post(base(schoolA))
      .set(as('super'))
      .send({ name: '', email: email('adminA'), password: 'short' })
      .expect(422);
    const errors = (res.body as Envelope).errors!;
    expect(errors.name).toEqual(['The name field is required.']);
    expect(errors.email).toEqual(['The email has already been taken.']);
    expect(errors.password).toEqual([
      'The password field must be at least 8 characters.',
    ]);
    const dupPhone = await http()
      .post(base(schoolB))
      .set(as('super'))
      .send({
        name: 'X',
        email: email('x'),
        phone: `+91${tag}01`,
        password: 'secret-123',
      })
      .expect(422);
    expect((dupPhone.body as Envelope).errors!.phone).toEqual([
      'The phone has already been taken.',
    ]);
  });

  it('refuses Bodhira Direct with 422 direct_school', async () => {
    const res = await http()
      .post(base(direct))
      .set(as('super'))
      .send({ name: 'D', email: email('d'), password: 'secret-123' })
      .expect(422);
    expect((res.body as Envelope).code).toBe('direct_school');
    expect(
      await db.query.users.findFirst({ where: eq(users.email, email('d')) }),
    ).toBeUndefined();
  });

  it('404s for an unknown school or a user who is not its admin', async () => {
    await http()
      .get('/api/v1/super/schools/999999999/admins')
      .set(as('super'))
      .expect(404);
    await http()
      .post('/api/v1/super/schools/999999999/admins')
      .set(as('super'))
      .send({ name: 'N', email: email('n'), password: 'secret-123' })
      .expect(404);
    // An admin of another school.
    await http()
      .patch(`${base(schoolB)}/${created.id}`)
      .set(as('super'))
      .send({ name: 'Moved', email: email('new') })
      .expect(404);
    await http()
      .post(`${base(schoolB)}/${created.id}/toggle`)
      .set(as('super'))
      .expect(404);
    // A teacher of the right school.
    const teacher = await db.query.users.findFirst({
      where: eq(users.email, email('teacherA')),
    });
    await http()
      .patch(`${base(schoolA)}/${teacher!.id}`)
      .set(as('super'))
      .send({ name: 'Promoted', email: email('teacherA') })
      .expect(404);
  });

  it('is for the Super Admin only', async () => {
    for (const who of ['adminA', 'teacherA', 'studentA']) {
      await http().get(base(schoolA)).set(as(who)).expect(403);
      await http()
        .post(base(schoolA))
        .set(as(who))
        .send({ name: 'Z', email: email(`z-${who}`), password: 'secret-123' })
        .expect(403);
      await http()
        .post(`${base(schoolA)}/${created.id}/toggle`)
        .set(as(who))
        .expect(403);
    }
  });

  it('edits the account; a new password ends its sessions', async () => {
    const tok = (
      (await login(email('new'), 'secret-123').expect(200)).body as Envelope<{
        token: string;
      }>
    ).data.token;
    const auth = { Authorization: `Bearer ${tok}` };
    await http().get('/api/v1/auth/me').set(auth).expect(200);

    // Without a password: the session survives.
    const res = await http()
      .patch(`${base(schoolA)}/${created.id}`)
      .set(as('super'))
      .send({ name: 'Renamed Admin', email: email('new'), phone: null })
      .expect(200);
    expect((res.body as Envelope<AdminRow>).data).toMatchObject({
      name: 'Renamed Admin',
      phone: null,
    });
    await http().get('/api/v1/auth/me').set(auth).expect(200);

    // Own email is not "taken"; another user's is.
    const dup = await http()
      .patch(`${base(schoolA)}/${created.id}`)
      .set(as('super'))
      .send({ name: 'Renamed Admin', email: email('adminA') })
      .expect(422);
    expect((dup.body as Envelope).errors!.email).toEqual([
      'The email has already been taken.',
    ]);

    await http()
      .patch(`${base(schoolA)}/${created.id}`)
      .set(as('super'))
      .send({
        name: 'Renamed Admin',
        email: email('new'),
        password: 'another-456',
      })
      .expect(200);
    await http().get('/api/v1/auth/me').set(auth).expect(401);
    await login(email('new'), 'secret-123').expect(422);
    await login(email('new'), 'another-456').expect(200);
  });

  it('deactivates (signing out, blocking sign-in) and reactivates', async () => {
    const tok = (
      (await login(email('new'), 'another-456').expect(200)).body as Envelope<{
        token: string;
      }>
    ).data.token;
    const off = await http()
      .post(`${base(schoolA)}/${created.id}/toggle`)
      .set(as('super'))
      .expect(200);
    expect((off.body as Envelope<{ status: string }>).data.status).toBe(
      'inactive',
    );
    await http()
      .get('/api/v1/auth/me')
      .set({ Authorization: `Bearer ${tok}` })
      .expect(401);
    const refused = await login(email('new'), 'another-456');
    expect(refused.status).toBe(403);

    const on = await http()
      .post(`${base(schoolA)}/${created.id}/toggle`)
      .set(as('super'))
      .expect(200);
    expect((on.body as Envelope<{ status: string }>).data.status).toBe(
      'active',
    );
    await login(email('new'), 'another-456').expect(200);
  });
});
