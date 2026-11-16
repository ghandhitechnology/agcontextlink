import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { config } from '../config.ts';
import * as schema from './schema.ts';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export const db = drizzle(pool, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
}
