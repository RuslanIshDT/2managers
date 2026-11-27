import { existsSync } from 'node:fs';
import { installLlmRecording } from '../db/llm-record.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
import { eq } from 'drizzle-orm';
import { agentRuns, leaders } from '../db/schema.ts';
import { accuracyView, measureAccuracy } from '../agents/accuracy.ts';
import { writeProtocol } from '../agents/protocol.ts';
import { loadDepartment } from '../agents/k1.ts';
import { sendFocusAll } from '../agents/focus-run.ts';
import { pullInbox } from '../agents/intake.ts';
import { readSyntheticInbox } from '../mail.ts';
import { seedIfEmpty, seedMissingCatalogs } from '../db/seed.ts';
import { reloadProfiles } from '../agents/profile-file.ts';
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
const profiles = await reloadProfiles(db);
if (profiles.length) console.log(`Профиль обновлён из файла: ${profiles.join(', ')}`);
const leaderRows = await db.select({ id: leaders.id }).from(leaders);
for (const row of leaderRows) {
  const dir = `data/${row.id}`;
  if (!existsSync(`${dir}/department.csv`)) continue;
  const department = await loadDepartment(db, row.id, dir);
  if (department.errors.length) console.error(`K1 ${row.id}: ${department.errors.join('; ')}`);
  else console.log(`K1 ${row.id}: подчинённых ${department.loaded}`);
}

const boss = await startBoss(connectionString, db);
// Утреннее сообщение — одно время для всех руководителей, 8:30 по Москве, раз в день (владелец 27.11.2026).
await boss.createQueue('focus-morning');
await boss.work('focus-morning', async () => {
  await sendFocusAll(db);
});
await boss.schedule('focus-morning', '30 8 * * *', {}, { tz: 'Europe/Moscow' });
// Прежняя пятничная отправка в 17:00 слала копию утра; расписание лежит в базе pg-boss, поэтому снимается явно.
await boss.unschedule('focus-friday');
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
await boss.createQueue('protocol');
await boss.work<{ leaderId: string }>('protocol', async (jobs) => {
  for (const job of jobs) {
    await db.insert(agentRuns).values({
      id: job.id,
      leaderId: job.data.leaderId,
      agent: 'protocol',
      reason: 'model',
      startedAt: new Date(),
      status: 'running',
    });
    try {
      const result = await writeProtocol(db, job.data.leaderId);
      await db
        .update(agentRuns)
        .set({ status: 'done', finishedAt: new Date(), detail: `протокол ${result.id} в Telegram, после утверждения уйдёт письмом` })
        .where(eq(agentRuns.id, job.id));
    } catch (err) {
      await db
        .update(agentRuns)
        .set({ status: 'failed', finishedAt: new Date(), detail: err instanceof Error ? err.message : 'сбой' })
        .where(eq(agentRuns.id, job.id));
    }
  }
});
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

installLlmRecording(db);

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
