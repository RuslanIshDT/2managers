// Записки и судьба серий встреч. Календарь не переписывается.
import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { emails, flowReports, noteSent, seriesFate, seriesKind } from '../db/schema.ts';
import { departmentForLeader } from './k1.ts';
import { burningSeries, pendingNotes, weeklyNotes, type SeriesView } from './mirror.ts';
import { listFlowRules } from './week.ts';
import { leaderMustConfirm } from './k2.ts';
import { mailConfig, sendMail } from '../mail.ts';

export async function mirrorForLeader(db: Db, leaderId: string) {
  const [department, mailRows, rules, fateRows, kindRows, view] = await Promise.all([
    departmentForLeader(db, leaderId),
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
    listFlowRules(db, leaderId),
    db.select().from(seriesFate).where(eq(seriesFate.leaderId, leaderId)),
    db.select().from(seriesKind).where(eq(seriesKind.leaderId, leaderId)),
    readView(db, leaderId),
  ]);
  const notes = weeklyNotes(
    department.people.map((person) => ({
      name: person.name,
      email: person.email,
      subjects: mailRows.filter((row) => row.fromEmail.toLowerCase() === person.email.toLowerCase()).map((row) => row.subject),
      lagging: person.kpis.some((kpi) => kpi.weeks.some((week) => week.status === 'отстаёт')),
      ownRules: rules
        .filter((rule) => rule.fromEmail.toLowerCase() === person.email.toLowerCase())
        .map((rule) => rule.title)
        .filter(Boolean),
    })),
  );
  const fate = new Map(fateRows.map((row) => [row.seriesKey, row]));
  const kinds = new Map(kindRows.map((row) => [row.seriesKey, row.kind]));
  const guarded = new Set(kindRows.filter((row) => leaderMustConfirm(row.category)).map((row) => row.seriesKey));
  const series = burningSeries(view).filter((item) => !guarded.has(item.title)).map((item) => ({
    ...item,
    action: fate.get(item.title)?.action ?? '',
    reason: fate.get(item.title)?.reason ?? '',
    kind: kinds.get(item.title) ?? '',
  }));
  return { notes, series };
}

export async function sendWeeklyNote(db: Db, leaderId: string) {
  const scene = await mirrorForLeader(db, leaderId);
  const sentRows = await db.select({ email: noteSent.email }).from(noteSent).where(eq(noteSent.leaderId, leaderId));
  const notes = pendingNotes(scene.notes, sentRows.map((row) => row.email));
  if (!notes.length) return { sent: [] as string[] };
  const cfg = mailConfig();
  if (!cfg) throw new Error('Яндекс Почта не настроена');
  for (const note of notes) {
    await sendMail(
      cfg.user,
      `Записка: ${note.name}`,
      `Кому: ${note.name} <${note.email}>\nАдрес подчинённого синтетический, поэтому письмо ушло в тестовый ящик.\n\n${note.text}`,
    );
    await db.insert(noteSent).values({ leaderId, email: note.email, sentAt: new Date() }).onConflictDoNothing();
  }
  return { sent: notes.map((note) => note.name) };
}

export async function setSeriesFate(db: Db, leaderId: string, seriesKey: string, action: string, reason: string) {
  if (action !== 'продлить' && action !== 'отпустить') throw new Error('Неизвестное действие');
  if (action === 'продлить' && reason.trim().length < 3) throw new Error('Для продления нужно обоснование');
  const scene = await mirrorForLeader(db, leaderId);
  if (!scene.series.some((item) => item.title === seriesKey)) throw new Error('Такой серии нет');
  await db
    .insert(seriesFate)
    .values({ leaderId, seriesKey, action, reason: reason.trim(), at: new Date() })
    .onConflictDoUpdate({
      target: [seriesFate.leaderId, seriesFate.seriesKey],
      set: { action, reason: reason.trim(), at: new Date() },
    });
  return { seriesKey, action };
}

async function readView(db: Db, leaderId: string): Promise<SeriesView[]> {
  const stored = await db.select().from(flowReports).where(eq(flowReports.leaderId, leaderId)).limit(1);
  const report = stored[0]?.report ?? JSON.parse(await readFile('reports/flow-audit.json', 'utf8'));
  const view = (report as { view?: unknown }).view;
  return Array.isArray(view) ? (view as SeriesView[]) : [];
}

export async function fateOf(db: Db, leaderId: string, seriesKey: string) {
  const rows = await db
    .select()
    .from(seriesFate)
    .where(and(eq(seriesFate.leaderId, leaderId), eq(seriesFate.seriesKey, seriesKey)))
    .limit(1);
  return rows[0] ?? null;
}
