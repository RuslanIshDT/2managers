// Переносит задачи и встречи всех руководителей в Трекер и в календарь «Стенд».
import { createDb, createPool, migrate } from '../db/client.ts';
import { leaders } from '../db/schema.ts';
import { syncLeader } from '../agents/stand-sync.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');

const pool = createPool(connectionString);
await migrate(pool);
const db = createDb(pool);
const rows = await db.select({ id: leaders.id, name: leaders.name }).from(leaders);
for (const row of rows) {
  const report = await syncLeader(db, row.id);
  console.log(`${row.name}: ${report}`);
}
await pool.end();
