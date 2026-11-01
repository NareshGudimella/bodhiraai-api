process.env.TZ = 'UTC';

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import { audit_logs, mail_settings } from '../src/db/schema';
import { MailSettingsService } from '../src/mail/mail-settings.service';

loadEnv();

/** not in legacy: /super/mail-settings. Needs the seeded local database. Leaves no mail_settings row behind. */
describe('Super admin mail settings (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let svc: MailSettingsService;
  let sup: { Authorization: string };
  let student: { Authorization: string };
  const http = () => request(app.getHttpServer());
  const URL = '/api/v1/super/mail-settings';

  const clear = async () => {
    await db.delete(mail_settings);
    svc.invalidate();
  };
  const valid = {
    mailer: 'smtp',
    host: 'smtp.example.test',
    port: 587,
    encryption: 'tls',
    username: 'mailer-user',
    password: 'p4ssw0rd-very-secret',
    from_address: 'noreply@example.test',
    from_name: 'Bodhira',
  };

  const login = async (identifier: string) => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'password', device: 'e2e-mail' })
      .expect(200);
    return { Authorization: `Bearer ${res.body.data.token as string}` };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    svc = app.get(MailSettingsService);
    sup = await login('super@bodhira.test');
    student = await login('student@bodhira.test');
    await clear();
  });

  afterAll(async () => {
    await clear();
    await app.close();
  });

  it('is super admin only', async () => {
    await http().get(URL).set(student).expect(403);
    await http().put(URL).set(student).send(valid).expect(403);
    await http()
      .post(`${URL}/test`)
      .set(student)
      .send({ to: 'a@example.test' })
      .expect(403);
    await http().get(URL).expect(401);
  });

  it('GET returns the settings without the password', async () => {
    const res = await http().get(URL).set(sup).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('password_set');
    expect(res.body.data).not.toHaveProperty('password');
    expect(res.body.data).not.toHaveProperty('password_enc');
    expect(res.body.data.source).toBe('env');
  });

  it('PUT validates with Laravel 422 keys', async () => {
    const res = await http().put(URL).set(sup).send({}).expect(422);
    expect(Object.keys(res.body.errors)).toEqual(
      expect.arrayContaining(['mailer', 'from_address']),
    );
    const bad = await http()
      .put(URL)
      .set(sup)
      .send({
        ...valid,
        mailer: 'smtp',
        host: null,
        port: 70000,
        encryption: 'starttls',
        from_address: 'nope',
      })
      .expect(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual(
      ['encryption', 'from_address', 'host', 'port'].sort(),
    );
    await http()
      .put(URL)
      .set(sup)
      .send({ ...valid, port: 0 })
      .expect(422);
    await http()
      .put(URL)
      .set(sup)
      .send({ ...valid, mailer: 'sendmail' })
      .expect(422);
    // nothing was saved
    expect((await db.select().from(mail_settings)).length).toBe(0);
  });

  it('PUT saves, encrypts the password, never returns it, and audits', async () => {
    const res = await http().put(URL).set(sup).send(valid).expect(200);
    expect(res.body.data).toMatchObject({
      source: 'database',
      mailer: 'smtp',
      host: 'smtp.example.test',
      port: 587,
      encryption: 'tls',
      username: 'mailer-user',
      password_set: true,
      from_address: 'noreply@example.test',
    });
    expect(JSON.stringify(res.body)).not.toContain(valid.password);

    const [row] = await db.select().from(mail_settings);
    expect(row.password_enc).toMatch(/^v1:/);
    expect(row.password_enc).not.toContain(valid.password);

    const get = await http().get(URL).set(sup).expect(200);
    expect(JSON.stringify(get.body)).not.toContain(valid.password);
    expect(get.body.data.password_set).toBe(true);

    const [log] = await db
      .select()
      .from(audit_logs)
      .where(eq(audit_logs.action, 'mail_settings.updated'))
      .orderBy(audit_logs.id)
      .limit(1)
      .offset(0);
    expect(log).toBeDefined();
    expect(log.changes).not.toContain(valid.password);
  });

  it('PUT with a blank password keeps the stored one; a new one replaces it', async () => {
    const [before] = await db.select().from(mail_settings);
    for (const password of [undefined, null, '']) {
      const res = await http()
        .put(URL)
        .set(sup)
        .send({ ...valid, password, host: 'smtp2.example.test' })
        .expect(200);
      expect(res.body.data.password_set).toBe(true);
    }
    const [kept] = await db.select().from(mail_settings);
    expect(kept.host).toBe('smtp2.example.test');
    expect(kept.password_enc).toBe(before.password_enc);

    await http()
      .put(URL)
      .set(sup)
      .send({ ...valid, password: 'another-password' })
      .expect(200);
    const [changed] = await db.select().from(mail_settings);
    expect(changed.password_enc).not.toBe(before.password_enc);
    expect((await db.select().from(mail_settings)).length).toBe(1);
  });

  it('test-send works with the log mailer and validates the address', async () => {
    await http()
      .put(URL)
      .set(sup)
      .send({
        mailer: 'log',
        from_address: 'noreply@example.test',
        encryption: 'none',
      })
      .expect(200);
    const res = await http()
      .post(`${URL}/test`)
      .set(sup)
      .send({ to: 'someone@example.test' })
      .expect(200);
    expect(res.body.data).toEqual({ sent: true });
    const bad = await http()
      .post(`${URL}/test`)
      .set(sup)
      .send({ to: 'nope' })
      .expect(422);
    expect(bad.body.errors).toHaveProperty('to');
  });

  it('test-send reports an SMTP failure without credentials', async () => {
    await http()
      .put(URL)
      .set(sup)
      .send({
        ...valid,
        host: '127.0.0.1',
        port: 1, // nothing listens here
        password: 'zz-secret-never-shown',
      })
      .expect(200);
    const res = await http()
      .post(`${URL}/test`)
      .set(sup)
      .send({ to: 'someone@example.test' })
      .expect(200);
    expect(res.body.data.sent).toBe(false);
    expect(typeof res.body.data.error).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('zz-secret-never-shown');
    expect(JSON.stringify(res.body)).not.toContain('mailer-user');
  });
});
