// Утром, вместе с сообщением руководителю: исполнителям — письмо о сроке сегодня и о просрочке.
// Одной задаче не больше одного письма в день. Задачи руководителя сюда не входят: они в его утреннем сообщении.
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { people, taskReminders, tasks } from '../db/schema.ts';
import { mailConfig, sendMail } from '../mail.ts';
import { reminderItems, reminderLetters } from './protocol-steps.ts';
import type { LiveTask } from './live-sources.ts';

export async function sendTaskReminders(db: Db, leaderId: string, leaderName: string, live: LiveTask[] | null, today: string): Promise<number> {
  const mailbox = mailConfig();
  if (!mailbox) return 0;
  const source =
    live ??
    (await db.select().from(tasks).where(eq(tasks.leaderId, leaderId))).map((row) => ({
      id: row.externalId,
      title: row.title,
      owner: row.ownerName,
      dueOn: row.dueOn,
      status: row.status,
    }));
  const sentRows = await db.select().from(taskReminders).where(and(eq(taskReminders.leaderId, leaderId), eq(taskReminders.day, today)));
  const sent = new Set(sentRows.map((row) => row.taskKey));
  const items = reminderItems(
    source.map((row) => ({ key: row.id, title: row.title, owner: row.owner, dueOn: row.dueOn, status: row.status })),
    today,
    leaderName,
    sent,
  );
  if (!items.length) return 0;
  const known = await db.select({ name: people.name, email: people.email }).from(people).where(eq(people.leaderId, leaderId));
  let count = 0;
  for (const letter of reminderLetters(items, known)) {
    try {
      await sendMail(mailbox.user, letter.subject, letter.text);
      await db
        .insert(taskReminders)
        .values(letter.keys.map((taskKey) => ({ leaderId, taskKey, day: today })))
        .onConflictDoNothing();
      count += 1;
    } catch (err) {
      console.error('Напоминание не ушло', err instanceof Error ? err.message : err);
    }
  }
  return count;
}
