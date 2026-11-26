import { existsSync } from 'node:fs';
import { setLlmSink } from '../llm.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
import { leaders, llmCalls } from '../db/schema.ts';
import { loadDepartment } from '../agents/k1.ts';
import { sendFocusAll } from '../agents/focus-run.ts';
import { seedIfEmpty, seedMissingCatalogs } from '../db/seed.ts';
import { startBoss } from '../jobs/flow-audit-job.ts';
import { buildApp } from './app.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');

const pool = createPool(connectionString);
await migrate(pool);
const db = createDb(pool);
const seeded = await seedIfEmpty(db);
if (seeded.seeded) console.log(`Каталог руководителя загружен. Вход: ${seeded.login}`);
const added = await seedMissingCatalogs(db);
if (added.length) console.log(`Добавлены входы: ${added.join(', ')}`);
const leaderRows = await db.select({ id: leaders.id }).from(leaders);
for (const row of leaderRows) {
  const dir = `data/${row.id}`;
  if (!existsSync(`${dir}/department.csv`)) continue;
  const department = await loadDepartment(db, row.id, dir);
  if (department.errors.length) console.error(`K1 ${row.id}: ${department.errors.join('; ')}`);
  else console.log(`K1 ${row.id}: подчинённых ${department.loaded}`);
}

const boss = await startBoss(connectionString, db);
for (const name of ['focus-morning', 'focus-friday']) {
  await boss.createQueue(name);
  await boss.work(name, async () => {
    await sendFocusAll(db);
  });
}
await boss.schedule('focus-morning', '30 8 * * *', {}, { tz: 'Europe/Moscow' });
await boss.schedule('focus-friday', '0 17 * * 5', {}, { tz: 'Europe/Moscow' });

setLlmSink(async (purpose, result) => {
  await db.insert(llmCalls).values({
    at: new Date(),
    purpose,
    model: result.model,
    ms: result.ms,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd === null ? null : String(result.costUsd),
  });
});

const app = await buildApp({
  db,
  pool,
  boss,
  standOrigin: process.env.STAND_ORIGIN,
});

const port = Number(process.env.PORT || 3000);
await app.listen({ port, host: '0.0.0.0' });

async function shutdown() {
  await app.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
}

process.on('SIGTERM', () => {
  shutdown()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
});
