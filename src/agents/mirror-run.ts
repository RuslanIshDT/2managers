// Записки и судьба серий встреч. Календарь не переписывается.
import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { emails, flowReports, seriesFate, seriesKind } from '../db/schema.ts';
import { departmentForLeader } from './k1.ts';
import { burningSeries, noteToSend, weeklyNotes, type SeriesView } from './mirror.ts';
import { listFlowRules } from './week.ts';
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
  const series = burningSeries(view).map((item) => ({
    ...item,
    action: fate.get(item.title)?.action ?? '',
    reason: fate.get(item.title)?.reason ?? '',
    kind: kinds.get(item.title) ?? '',
  }));
  return { notes, series };
}

export async function sendWeeklyNote(db: Db, leaderId: string) {
  const scene = await mirrorForLeader(db, leaderId);
  const note = noteToSend(scene.notes);
  if (!note) throw new Error('Записок нет');
  const cfg = mailConfig();
  if (!cfg) throw new Error('Яндекс Почта не настроена');
  await sendMail(
    cfg.user,
    `Записка: ${note.name}`,
    `Кому: ${note.name} <${note.email}>\nАдрес подчинённого синтетический, поэтому письмо ушло в тестовый ящик.\n\n${note.text}`,
  );
  return { name: note.name, quiet: note.quiet };
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
