import { setLlmSink } from '../llm.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
import { llmCalls } from '../db/schema.ts';
import { seedIfEmpty } from '../db/seed.ts';
import { startBoss } from '../jobs/flow-audit-job.ts';
import { buildApp } from './app.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');

const pool = createPool(connectionString);
await migrate(pool);
const db = createDb(pool);
const seeded = await seedIfEmpty(db);
if (seeded.seeded) console.log(`Каталог руководителя загружен. Вход: ${seeded.login}`);

const boss = await startBoss(connectionString, db);

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
