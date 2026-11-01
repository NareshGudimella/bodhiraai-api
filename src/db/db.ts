import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import { requireEnv } from '../config/env';
import * as schema from './schema';

/** Injection token for the Drizzle client: `@Inject(DB) private readonly db: Db`. */
export const DB = Symbol('DB');

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

// COUNT(*) and SUM() come back as int8/numeric strings; the app wants numbers,
// as Prisma returned them. (Drizzle's bigint columns convert separately.)
types.setTypeParser(types.builtins.INT8, (v) => Number(v));
types.setTypeParser(types.builtins.NUMERIC, (v) => Number(v));

/**
 * A Drizzle client on DATABASE_URL (postgres://…). DB_POOL_MAX connections per
 * instance: keep instances × DB_POOL_MAX under the database's connection limit.
 */
export function createDb(url = requireEnv('DATABASE_URL')): Db {
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX) || 10,
  });
  return drizzle(pool, { schema });
}

export { schema };
