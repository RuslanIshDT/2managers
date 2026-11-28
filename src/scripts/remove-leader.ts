// Удаляет руководителя и его данные по логину. Без --yes ничего не удаляет.
// Руководителя с привязанным Telegram не удаляет.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { createDb, createPool } from '../db/client.ts';
import {
  agentModels,
  agentRuns,
  authorities,
  confirmationAudiences,
  decisions,
  emailEtalon,
  emails,
  flowReports,
  focusPlans,
  freedSlots,
  kpis,
  leaderActs,
  leaders,
  llmCalls,
  mailActions,
  mailIn,
  meetingEtalon,
  meetings,
  noteSent,
  operations,
  people,
  protocols,
  revisions,
  rules,
  seriesFate,
  seriesKind,
  sessions,
  taskReminders,
  tasks,
  telegramClicks,
  verdicts,
} from '../db/schema.ts';

export function removalRefusal(row: { telegramChatId: string | null } | undefined): string | null {
  if (!row) return 'Руководитель с таким логином не найден';
  if (row.telegramChatId) return 'К этому руководителю привязан Telegram, удаление отклонено';
  return null;
}

const childTables = [
  sessions,
  people,
  emails,
  emailEtalon,
  meetings,
  meetingEtalon,
  tasks,
  kpis,
  authorities,
  mailIn,
  verdicts,
  decisions,
  revisions,
  leaderActs,
  rules,
  freedSlots,
  seriesFate,
  focusPlans,
  seriesKind,
  protocols,
  taskReminders,
  noteSent,
  mailActions,
  confirmationAudiences,
  flowReports,
  agentModels,
  operations,
  agentRuns,
  telegramClicks,
  llmCalls,
];

export async function removeLeader(db: Db, leaderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of childTables) {
      await tx.delete(table).where(eq(table.leaderId, leaderId));
    }
    await tx.delete(leaders).where(eq(leaders.id, leaderId));
  });
}

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes');
  const login = process.argv.slice(2).find((arg) => arg !== '--yes') ?? '';
  if (!login) {
    console.log('Укажите логин. Без --yes ничего не удаляется. Руководитель с Telegram не удаляется.');
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL не задан');
  const pool = createPool(connectionString);
  const db = createDb(pool);
  const [row] = await db
    .select({ id: leaders.id, name: leaders.name, telegramChatId: leaders.telegramChatId })
    .from(leaders)
    .where(eq(leaders.login, login));
  const refusal = removalRefusal(row);
  if (refusal || !row) {
    console.log(refusal ?? 'Руководитель с таким логином не найден');
    await pool.end();
    return;
  }
  if (!yes) {
    console.log(`Будет удалён ${row.name} (${row.id}) и его данные. Повторите с --yes. Сейчас ничего не удалено.`);
    await pool.end();
    return;
  }
  await removeLeader(db, row.id);
  console.log(`Удалён ${row.name} (${row.id}).`);
  await pool.end();
}

if (process.argv[1]?.includes('remove-leader')) await main();
