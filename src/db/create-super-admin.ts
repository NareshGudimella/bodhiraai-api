/**
 * not in legacy. `npm run user:create-super-admin -- --email a@b.c --name "A B"`:
 * creates an active super admin (no school), the first real account of a fresh
 * database (staging, or production before data is imported).
 *
 * The password comes from SUPER_ADMIN_PASSWORD, else it is asked for on the
 * terminal (not echoed), else read from the first line of stdin. It is never
 * printed or logged. At least 12 characters (security: not in legacy; the
 * account can do everything). Stored as `$2y$` bcrypt like every other user.
 * Refuses an email that already belongs to a user.
 */
process.env.TZ = 'UTC';

import { loadEnv } from '../config/env';
loadEnv();

import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import { Role } from '../common/roles';
import { createDb, type Db } from './db';
import { users } from './schema';

const MIN_PASSWORD = 12;

/** `--key value` and `--key=value` pairs. */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    if (m[2] !== undefined) out[m[1]] = m[2];
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--'))
      out[m[1]] = argv[++i];
  }
  return out;
}

/** Ask without echoing (TTY), or take the first line of piped stdin. */
function readPassword(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c: string) => (data += c));
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
      stdin.on('error', reject);
    });
  }
  return new Promise((resolve) => {
    const rl = createInterface({
      input: stdin,
      output: process.stdout,
      terminal: true,
    });
    // Mute the echo after the prompt is written.
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let muted = false;
    out._writeToOutput = (s: string) => {
      if (!muted) process.stdout.write(s);
    };
    rl.question('Password: ', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

export async function createSuperAdmin(
  db: Db,
  input: { email: string; name: string; password: string },
) {
  const email = input.email.trim();
  const name = input.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error('--email must be a valid email address');
  if (name === '') throw new Error('--name is required');
  if (input.password.length < MIN_PASSWORD)
    throw new Error(`The password must be at least ${MIN_PASSWORD} characters`);
  // citext: compares case-insensitively, like legacy's unique index.
  if (await db.query.users.findFirst({ where: eq(users.email, email) }))
    throw new Error(`A user with the email ${email} already exists`);
  const now = new Date();
  const [row] = await db
    .insert(users)
    .values({
      name,
      email,
      password: await hashPassword(input.password),
      role: Role.SuperAdmin,
      status: 'active',
      school_id: null,
      created_at: now,
      updated_at: now,
    })
    .returning({ id: users.id });
  return row.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.name)
    throw new Error(
      'Usage: npm run user:create-super-admin -- --email <email> --name "<name>"',
    );
  const password = process.env.SUPER_ADMIN_PASSWORD || (await readPassword());
  const db = createDb();
  try {
    const id = await createSuperAdmin(db, {
      email: args.email,
      name: args.name,
      password,
    });
    console.log(`Created super admin #${id} (${args.email.trim()}).`);
  } finally {
    await db.$client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
