import { existsSync } from 'node:fs';
import { setLlmSink } from '../llm.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
import { eq } from 'drizzle-orm';
import { agentRuns, leaders, llmCalls } from '../db/schema.ts';
import { accuracyView, measureAccuracy } from '../agents/accuracy.ts';
import { loadDepartment } from '../agents/k1.ts';
import { sendFocusAll } from '../agents/focus-run.ts';
import { pullInbox } from '../agents/intake.ts';
import { readSyntheticInbox } from '../mail.ts';
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
await boss.createQueue('inbox-poll');
await boss.work('inbox-poll', async () => {
  let letters;
  try {
    letters = await readSyntheticInbox();
  } catch (err) {
    console.error('Ящик не прочитан', err);
    return;
  }
  const bound = await db.select({ id: leaders.id, chat: leaders.telegramChatId }).from(leaders);
  const inboxOwner = bound.find((row) => row.chat)?.id;
  for (const row of bound) {
    if (row.id !== inboxOwner) continue;
    await pullInbox(db, row.id, letters.filter((letter) => letter.marked === false), 1);
  }
});
await boss.schedule('inbox-poll', '* * * * *', {}, { tz: 'Europe/Moscow' });
await boss.createQueue('mail-accuracy');
await boss.work<{ leaderId: string }>('mail-accuracy', async (jobs) => {
  for (const job of jobs) {
    await db.insert(agentRuns).values({
      id: job.id,
      leaderId: job.data.leaderId,
      agent: 'accuracy',
      reason: 'model',
      startedAt: new Date(),
      status: 'running',
    });
    try {
      const result = await measureAccuracy(db, job.data.leaderId);
      const view = await accuracyView(db, job.data.leaderId);
      await db
        .update(agentRuns)
        .set({
          status: 'done',
          finishedAt: new Date(),
          detail: view ? `${view.hit} из ${view.total}, новых вызовов ${result.calls}` : `новых вызовов ${result.calls}`,
        })
        .where(eq(agentRuns.id, job.id));
    } catch (err) {
      await db
        .update(agentRuns)
        .set({ status: 'failed', finishedAt: new Date(), detail: err instanceof Error ? err.message : 'сбой' })
        .where(eq(agentRuns.id, job.id));
    }
  }
});

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
