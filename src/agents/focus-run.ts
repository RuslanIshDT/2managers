// Сборка утра и матрицы из базы и отправка в Telegram.
import { eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { decisions, leaders, meetings, tasks } from '../db/schema.ts';
import { departmentForLeader } from './k1.ts';
import { departmentMatrix, goalMinutes, morningLines } from './focus.ts';
import { sendMessage } from '../telegram.ts';

export async function focusForLeader(db: Db, leaderId: string, leaderName: string) {
  const [department, taskRows, decisionRows, meetingRows] = await Promise.all([
    departmentForLeader(db, leaderId),
    db.select().from(tasks).where(eq(tasks.leaderId, leaderId)),
    db.select().from(decisions).where(eq(decisions.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
  ]);
  const matrix = departmentMatrix(
    department.people.map((person) => ({
      name: person.name,
      emails: person.emails,
      lagging: person.kpis.some((kpi) => kpi.weeks.some((week) => week.status === 'отстаёт')),
    })),
  );
  const ownTasks = taskRows
    .filter((row) => row.ownerName === leaderName)
    .map((row) => ({ title: row.title, dueOn: row.dueOn }));
  const waiting = decisionRows
    .filter((row) => row.status === 'ждёт')
    .map((row) => ({ who: row.replyName, summary: row.summary }));
  const lines = morningLines({
    tasks: ownTasks,
    waiting,
    quiet: matrix.filter((row) => row.quiet).map((row) => row.name),
  });
  const share = goalMinutes(
    meetingRows.map((row) => ({ minutes: row.minutes, summary: row.summary })),
    department.people.flatMap((person) => [person.goal, person.leaderGoal]),
  );
  const text = [
    ...lines,
    '',
    'Матрица отдела:',
    ...matrix.map((row) => `— ${row.name}: ${row.basis}`),
    '',
    `Календарь на цели: ${share.percent}% (${share.onGoal} из ${share.total} мин).`,
  ].join('\n');
  return { matrix, share, text };
}

export async function sendFocus(db: Db, leaderId: string) {
  const [leader] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader) throw new Error('Руководитель не найден');
  if (!leader.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
  const scene = await focusForLeader(db, leader.id, leader.name);
  await sendMessage(scene.text, leader.telegramChatId);
  return scene;
}

export async function sendFocusAll(db: Db) {
  const rows = await db.select().from(leaders).where(isNotNull(leaders.telegramChatId));
  for (const leader of rows) {
    if (!leader.telegramChatId) continue;
    await sendFocus(db, leader.id);
  }
}
