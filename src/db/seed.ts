import { randomBytes } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { emailEtalon, emails, leaders, meetingEtalon, meetings, people, tasks } from './schema.ts';
import { hashPassword } from '../auth.ts';
import { loadSynthetic, type Synthetic } from '../data/synthetic.ts';

export const LEADER_ID = 'synthetic';

export async function seedIfEmpty(db: Db, dir = 'data/synthetic') {
  const existing = await db.select({ n: count() }).from(leaders);
  if ((existing[0]?.n ?? 0) > 0) return { seeded: false as const };

  const data = await loadSynthetic(dir);
  const leaderPerson = data.people.find((p) => p.role === 'руководитель');
  const login = process.env.LEADER_LOGIN || 'ivan';
  const password = process.env.LEADER_PASSWORD;
  if (!password) throw new Error('LEADER_PASSWORD не задан (.env)');
  const linkCode = process.env.LEADER_LINK_CODE || randomBytes(4).toString('hex');

  await db.insert(leaders).values({
    id: LEADER_ID,
    name: leaderPerson?.name ?? 'Руководитель',
    login,
    passwordHash: await hashPassword(password),
    profile: data.profile,
    linkCode,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
  });

  await insertCatalog(db, LEADER_ID, data);

  const row = await db.select({ linkCode: leaders.linkCode }).from(leaders).where(eq(leaders.id, LEADER_ID));
  return { seeded: true as const, login, linkCode: row[0]?.linkCode ?? linkCode };
}

export async function insertCatalog(db: Db, leaderId: string, data: Synthetic) {
  if (data.people.length) {
    await db.insert(people).values(
      data.people.map((person) => ({
        leaderId,
        externalId: person.id,
        name: person.name,
        position: person.position,
        role: person.role,
        reportsTo: person.reportsTo,
        email: person.email,
      })),
    );
  }
  if (data.emails.length) {
    await db.insert(emails).values(
      data.emails.map((email) => ({
        leaderId,
        externalId: email.id,
        received: email.received,
        fromName: email.fromName,
        fromEmail: email.fromEmail,
        senderRole: email.senderRole,
        toAddr: email.to,
        subject: email.subject,
        body: email.body,
      })),
    );
    await db.insert(emailEtalon).values(
      [...data.emailEtalon.values()].map((row) => ({
        leaderId,
        externalId: row.id,
        category: row.category,
        expectedAction: row.expectedAction,
        reason: row.reason,
      })),
    );
  }
  if (data.meetings.length) {
    await db.insert(meetings).values(
      data.meetings.map((meeting) => ({
        leaderId,
        uid: meeting.uid,
        startsAt: meeting.start,
        endsAt: meeting.end,
        minutes: meeting.minutes,
        summary: meeting.summary,
        organizer: meeting.organizer,
        attendees: meeting.attendees,
      })),
    );
    await db.insert(meetingEtalon).values(
      [...data.meetingEtalon.values()].map((row) => ({
        leaderId,
        uid: row.uid,
        category: row.category,
      })),
    );
  }
  if (data.tasks.length) {
    await db.insert(tasks).values(
      data.tasks.map((task) => ({
        leaderId,
        externalId: task.id,
        title: task.task,
        ownerName: task.owner,
        dueOn: task.due,
        status: task.status,
        source: task.source,
      })),
    );
  }
}
