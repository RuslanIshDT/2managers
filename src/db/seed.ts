import { randomBytes, randomUUID } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { emailEtalon, emails, leaders, meetingEtalon, meetings, people, tasks } from './schema.ts';
import { hashPassword } from '../auth.ts';
import { loadSynthetic } from '../data/synthetic.ts';

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

  if (data.people.length) {
    await db.insert(people).values(
      data.people.map((p) => ({
        leaderId: LEADER_ID,
        externalId: p.id,
        name: p.name,
        position: p.position,
        role: p.role,
        reportsTo: p.reportsTo,
        email: p.email,
      })),
    );
  }
  if (data.emails.length) {
    await db.insert(emails).values(
      data.emails.map((e) => ({
        leaderId: LEADER_ID,
        externalId: e.id,
        received: e.received,
        fromName: e.fromName,
        fromEmail: e.fromEmail,
        senderRole: e.senderRole,
        toAddr: e.to,
        subject: e.subject,
        body: e.body,
      })),
    );
    await db.insert(emailEtalon).values(
      [...data.emailEtalon.values()].map((e) => ({
        leaderId: LEADER_ID,
        externalId: e.id,
        category: e.category,
        expectedAction: e.expectedAction,
        reason: e.reason,
      })),
    );
  }
  if (data.meetings.length) {
    await db.insert(meetings).values(
      data.meetings.map((m) => ({
        leaderId: LEADER_ID,
        uid: m.uid,
        startsAt: m.start,
        endsAt: m.end,
        minutes: m.minutes,
        summary: m.summary,
        organizer: m.organizer,
        attendees: m.attendees,
      })),
    );
    await db.insert(meetingEtalon).values(
      [...data.meetingEtalon.values()].map((m) => ({
        leaderId: LEADER_ID,
        uid: m.uid,
        category: m.category,
      })),
    );
  }
  if (data.tasks.length) {
    await db.insert(tasks).values(
      data.tasks.map((t) => ({
        leaderId: LEADER_ID,
        externalId: t.id,
        title: t.task,
        ownerName: t.owner,
        dueOn: t.due,
        status: t.status,
        source: t.source,
      })),
    );
  }

  const row = await db.select({ linkCode: leaders.linkCode }).from(leaders).where(eq(leaders.id, LEADER_ID));
  return { seeded: true as const, login, linkCode: row[0]?.linkCode ?? linkCode };
}

export async function seedMissingCatalogs(db: Db, root = 'data'): Promise<string[]> {
  const added: string[] = [];
  const names = await readdir(root);
  const existing = new Set((await db.select({ id: leaders.id }).from(leaders)).map((row) => row.id));
  for (const dir of names) {
    if (existing.has(dir)) continue;
    const base = join(root, dir);
    try {
      await access(join(base, 'leader_profile.md'));
    } catch {
      continue;
    }
    const password = process.env[`${dir.toUpperCase()}_PASSWORD`];
    if (!password) {
      console.error(`Каталог ${dir}: нет ${dir.toUpperCase()}_PASSWORD, вход не создан`);
      continue;
    }
    const login = await catalogLogin(base, dir);
    const data = await loadSynthetic(base);
    const leader = data.people.find((person) => person.role === 'руководитель');
    if (!leader) continue;
    const linkCode = randomUUID().slice(0, 8);
    await db.insert(leaders).values({
      id: dir,
      name: leader.name,
      login,
      passwordHash: await hashPassword(password),
      profile: data.profile,
      linkCode,
      telegramChatId: null,
    });
    if (data.people.length) {
      await db.insert(people).values(
        data.people.map((person) => ({
          leaderId: dir,
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
          leaderId: dir,
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
          leaderId: dir,
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
          leaderId: dir,
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
          leaderId: dir,
          uid: row.uid,
          category: row.category,
        })),
      );
    }
    if (data.tasks.length) {
      await db.insert(tasks).values(
        data.tasks.map((task) => ({
          leaderId: dir,
          externalId: task.id,
          title: task.task,
          ownerName: task.owner,
          dueOn: task.due,
          status: task.status,
          source: task.source,
        })),
      );
    }
    added.push(login);
  }
  return added;
}

async function catalogLogin(base: string, fallback: string): Promise<string> {
  try {
    const raw = await readFile(join(base, 'account.csv'), 'utf8');
    const row = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && line !== 'login' && !line.startsWith('#'));
    return row || fallback;
  } catch {
    return fallback;
  }
}
