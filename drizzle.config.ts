import { defineConfig } from 'drizzle-kit';
import { loadEnv } from './src/config/env';

loadEnv();

/** The PostgreSQL schema is owned here: `npm run db:generate` after editing src/db/schema.ts, `npm run db:migrate` to apply. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
