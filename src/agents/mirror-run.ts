// Записки и судьба серий встреч. «Отпустить» освобождает будущие встречи серии в календаре «Стенд»
// и ставит на их время приоритет руководителя; «Продлить» возвращает встречи на место.
import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { emails, flowReports, freedSlots, leaders, meetings, noteSent, seriesFate, seriesKind } from '../db/schema.ts';
import { calendarConfig, deleteByUid, ensureStandCalendar, eventHrefs, putEvent } from '../yandex/calendar.ts';
import { blockDescription, freeUses, LEAVE_FREE, minutesWords, plural, slotsToFree, type FreeUse } from './free-time.ts';
import { departmentMatrix } from './focus.ts';
import { clockFor, dateWords } from './scene.ts';
import { freeBlock, freeBlockUid, meetingEvent, meetingUid } from './stand-sync.ts';
import { departmentForLeader } from './k1.ts';
import { burningSeries, pendingNotes, weeklyNotes, type SeriesView } from './mirror.ts';
import { listFlowRules } from './week.ts';
import { leaderMustConfirm } from './k2.ts';
import { mailConfig, sendMail } from '../mail.ts';

export async function mirrorForLeader(db: Db, leaderId: string) {
  const [department, mailRows, rules, fateRows, kindRows, view, leaderRows, freedRows] = await Promise.all([
    departmentForLeader(db, leaderId),
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
    listFlowRules(db, leaderId),
    db.select().from(seriesFate).where(eq(seriesFate.leaderId, leaderId)),
    db.select().from(seriesKind).where(eq(seriesKind.leaderId, leaderId)),
    readView(db, leaderId),
    db.select({ profile: leaders.profile }).from(leaders).where(eq(leaders.id, leaderId)).limit(1),
    db.select().from(freedSlots).where(eq(freedSlots.leaderId, leaderId)),
  ]);
  const matrix = departmentMatrix(
    department.people.map((person) => ({
      name: person.name,
      emails: person.emails,
      lagging: person.kpis.some((kpi) => kpi.weeks.some((week) => week.status === 'отстаёт')),
    })),
  );
  const uses = freeUses(leaderRows[0]?.profile ?? '', matrix);
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
    freed: freedOf(freedRows.filter((row) => row.seriesKey === item.title)),
  }));
  return { notes, series, uses };
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

function freedOf(rows: { startsAt: string; minutes: number; useTitle: string; useId: string }[]) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return {
    count: rows.length,
    minutes: rows.reduce((sum, row) => sum + row.minutes, 0),
    use: sorted[0]?.useTitle ?? '',
    useId: sorted[0]?.useId ?? '',
    dates: sorted.map((row) => dateWords(row.startsAt)),
  };
}

export async function setSeriesFate(db: Db, leaderId: string, seriesKey: string, action: string, reason: string, useId = '') {
  if (action !== 'продлить' && action !== 'отпустить') throw new Error('Неизвестное действие');
  if (action === 'продлить' && reason.trim().length < 3) throw new Error('Для продления нужно обоснование');
  const scene = await mirrorForLeader(db, leaderId);
  const item = scene.series.find((row) => row.title === seriesKey);
  if (!item) throw new Error('Такой серии нет');
  const use = action === 'отпустить' ? scene.uses.find((row) => row.id === useId) ?? scene.uses[0] : null;
  if (action === 'отпустить' && !use) throw new Error('Не из чего выбрать приоритет');
  const text = use ? await freeSeries(db, leaderId, seriesKey, item.change, use) : await restoreSeries(db, leaderId, seriesKey);
  await db
    .insert(seriesFate)
    .values({ leaderId, seriesKey, action, reason: reason.trim(), at: new Date() })
    .onConflictDoUpdate({
      target: [seriesFate.leaderId, seriesFate.seriesKey],
      set: { action, reason: reason.trim(), at: new Date() },
    });
  return { seriesKey, action, text };
}

// Будущие встречи серии уходят из календаря «Стенд», на их время встаёт блок выбранного приоритета.
// Сначала календарь, потом база: при сбое календаря повтор кнопки доделает то же самое.
async function freeSeries(db: Db, leaderId: string, seriesKey: string, change: string, use: FreeUse): Promise<string> {
  const meetingRows = await db.select().from(meetings).where(eq(meetings.leaderId, leaderId));
  const slots = slotsToFree(meetingRows, seriesKey, clockFor(leaderId).today);
  if (!slots.length) return 'Будущих встреч у серии нет: календарь не менялся.';
  const keep = use.id !== LEAVE_FREE;
  const calendar = calendarConfig();
  if (calendar) {
    const href = await ensureStandCalendar();
    const hrefs = await eventHrefs(href);
    for (const slot of slots) {
      await deleteByUid(hrefs, meetingUid(leaderId, slot.uid));
      if (keep) {
        const block = freeBlock(leaderId, slot, { seriesKey, useSummary: use.summary, description: blockDescription({ seriesKey, change, why: use.why }) });
        await putEvent(href, block.file, block.ics);
      } else {
        await deleteByUid(hrefs, freeBlockUid(leaderId, slot.uid));
      }
    }
  }
  await db.delete(freedSlots).where(and(eq(freedSlots.leaderId, leaderId), eq(freedSlots.seriesKey, seriesKey)));
  await db.insert(freedSlots).values(
    slots.map((slot) => ({
      leaderId,
      meetingUid: slot.uid,
      seriesKey,
      startsAt: slot.startsAt,
      minutes: slot.minutes,
      useId: use.id,
      useTitle: use.title,
      useSummary: keep ? use.summary : '',
      at: new Date(),
    })),
  );
  const minutes = slots.reduce((sum, slot) => sum + slot.minutes, 0);
  const dates = slots.map((slot) => dateWords(slot.startsAt)).join(', ');
  const where = calendar ? 'в календаре «Стенд»' : 'на стенде (календарь не настроен)';
  return keep
    ? `Освобождено ${minutesWords(minutes)} (${dates}): ${where} вместо встреч серии — «${use.summary}».`
    : `Освобождено ${minutesWords(minutes)} (${dates}): ${where} встреч серии больше нет, время свободно.`;
}

// Продление после отпуска: блоки приоритета снимаются, встречи серии возвращаются.
async function restoreSeries(db: Db, leaderId: string, seriesKey: string): Promise<string> {
  const freedRows = await db.select().from(freedSlots).where(and(eq(freedSlots.leaderId, leaderId), eq(freedSlots.seriesKey, seriesKey)));
  if (!freedRows.length) return 'Серия продлена, календарь не менялся.';
  const uids = new Set(freedRows.map((row) => row.meetingUid));
  const meetingRows = (await db.select().from(meetings).where(eq(meetings.leaderId, leaderId))).filter((row) => uids.has(row.uid));
  if (calendarConfig()) {
    const subjects = (await db.select({ subject: emails.subject }).from(emails).where(eq(emails.leaderId, leaderId))).map((row) => row.subject);
    const href = await ensureStandCalendar();
    const hrefs = await eventHrefs(href);
    for (const meeting of meetingRows) {
      await deleteByUid(hrefs, freeBlockUid(leaderId, meeting.uid));
      const event = meetingEvent(leaderId, meeting, subjects);
      await putEvent(href, event.file, event.ics);
    }
  }
  await db.delete(freedSlots).where(and(eq(freedSlots.leaderId, leaderId), eq(freedSlots.seriesKey, seriesKey)));
  return `Серия продлена: ${plural(meetingRows.length, 'встреча', 'встречи', 'встреч')} снова в календаре.`;
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
