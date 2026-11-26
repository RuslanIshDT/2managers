import { readdir, readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function createPool(connectionString: string) {
  return new pg.Pool({ connectionString, max: 10 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

export async function migrate(pool: pg.Pool) {
  const dir = new URL('../../drizzle/', import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of names) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    await pool.query(sql);
  }
}
