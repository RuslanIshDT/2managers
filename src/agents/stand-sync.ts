// Кладёт задачи и встречи руководителя в Трекер и в календарь «Стенд». Повтор не плодит копии.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { emails, freedSlots, meetings, protocols, tasks } from '../db/schema.ts';
import { calendarConfig, ensureStandCalendar, listStandEvents, putEvent } from '../yandex/calendar.ts';
import { createIssue, listOurIssues, trackerConfig } from '../yandex/tracker.ts';
import { attendeeNames, eventFile, issueDraft, meetingStart, relatedSubjects, standEvent, taskUnique } from './materials.ts';
import { meetingOfSource, releaseFor } from './protocol.ts';
import { seriesDescriptions } from './protocol-context.ts';

export interface StandSnapshot {
  tracker: { ok: boolean; detail: string; issues: { key: string; summary: string; deadline: string }[] };
  calendar: { ok: boolean; detail: string; events: { summary: string; start: string }[] };
}

const cache = new Map<string, { at: number; value: StandSnapshot }>();

export async function standView(leaderId: string, db?: Db): Promise<StandSnapshot> {
  const hit = cache.get(leaderId);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const known = db ? new Set((await db.select({ id: tasks.externalId }).from(tasks).where(eq(tasks.leaderId, leaderId))).map((row) => taskUnique(leaderId, row.id))) : null;
  const value = await loadStand(leaderId, known);
  cache.set(leaderId, { at: Date.now(), value });
  return value;
}

export async function syncLeader(db: Db, leaderId: string): Promise<string> {
  const subjects = (await db.select({ subject: emails.subject }).from(emails).where(eq(emails.leaderId, leaderId))).map((row) => row.subject);
  const taskRows = await db.select().from(tasks).where(eq(tasks.leaderId, leaderId));
  const meetingRows = await db.select().from(meetings).where(eq(meetings.leaderId, leaderId));
  const protocolRows = await db.select().from(protocols).where(eq(protocols.leaderId, leaderId));
  const freedRows = await db.select().from(freedSlots).where(eq(freedSlots.leaderId, leaderId));
  const freed = new Map(freedRows.map((row) => [row.meetingUid, row]));
  let created = 0;
  let existed = 0;
  let trackerFailed = 0;
  if (trackerConfig()) {
    for (const task of taskRows) {
      const draft = issueDraft(task, relatedSubjects(task.title, subjects));
      try {
        const result = await createIssue({ unique: taskUnique(leaderId, task.externalId), ...draft });
        if (result === 'exists') existed += 1;
        else created += 1;
      } catch {
        trackerFailed += 1;
      }
    }
  }
  let written = 0;
  let calendarFailed = 0;
  if (calendarConfig()) {
    const href = await ensureStandCalendar();
    // Цепочка темы, вопросы по прошлому протоколу и протокол встречи — в описании события (T69).
    const notes = await seriesDescriptions(db, leaderId, meetingRows.filter((row) => !freed.has(row.uid)));
    for (const meeting of meetingRows) {
      // Встреча отпущенной серии в календарь не возвращается: на её месте блок приоритета или ничего.
      const slot = freed.get(meeting.uid);
      const event = slot ? (slot.useSummary ? freeBlock(leaderId, meeting, slot) : null) : meetingEvent(leaderId, meeting, subjects, notes.get(meeting.uid) ?? []);
      if (!event) continue;
      try {
        await putEvent(href, event.file, event.ics);
        written += 1;
      } catch {
        calendarFailed += 1;
      }
    }
    for (const row of protocolRows) {
      // Протокол встречи из календаря уже в описании событий темы; отдельное событие — только для протокола без встречи.
      if (row.status !== 'утверждён' || meetingOfSource(row.source)) continue;
      const release = await releaseFor(db, leaderId, row);
      const uid = release.eventUid || `${leaderId}:protocol-${row.id}`;
      const ics = release.eventUid ? release.ics : release.ics.replace(/^UID:.*$/m, `UID:${uid}@ecompras`);
      try {
        await putEvent(href, eventFile(uid), ics);
        written += 1;
      } catch {
        calendarFailed += 1;
      }
    }
  }
  cache.clear();
  const trackerText = trackerConfig() ? `В Трекере новых задач ${created}, уже были ${existed}${trackerFailed ? `, не приняты ${trackerFailed}` : ''}.` : 'Трекер не настроен.';
  const calendarText = calendarConfig() ? `В календарь «Стенд» записано событий ${written}${calendarFailed ? `, не записано ${calendarFailed}` : ''}.` : 'Календарь не настроен.';
  return `${trackerText} ${calendarText}`;
}

type MeetingRow = typeof meetings.$inferSelect;

export function meetingEvent(leaderId: string, meeting: MeetingRow, subjects: string[], notes: string[] = []): { file: string; ics: string } {
  const names = attendeeNames(meeting.attendees);
  const near = relatedSubjects(meeting.summary, subjects);
  const description = [
    names.length ? `Участники: ${names.join(', ')}.` : '',
    meeting.organizer ? `Организатор: ${meeting.organizer}.` : '',
    near.length ? `Рядом в почте: ${near.join('; ')}.` : '',
    ...(notes.length ? ['', ...notes] : []),
  ]
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
    .join('\n');
  const uid = meetingUid(leaderId, meeting.uid);
  return {
    file: eventFile(uid),
    ics: standEvent({ uid, start: meetingStart(meeting.startsAt), minutes: meeting.minutes, summary: meeting.summary, description }),
  };
}

export function meetingUid(leaderId: string, uid: string): string {
  return `${leaderId}:${uid}`;
}

export function freeBlockUid(leaderId: string, uid: string): string {
  return `${leaderId}:free:${uid}`;
}

export function freeBlock(
  leaderId: string,
  meeting: { uid: string; startsAt: string; minutes: number },
  slot: { seriesKey: string; useSummary: string; description?: string },
): { file: string; ics: string } {
  const uid = freeBlockUid(leaderId, meeting.uid);
  return {
    file: eventFile(uid),
    ics: standEvent({
      uid,
      start: meetingStart(meeting.startsAt),
      minutes: meeting.minutes,
      summary: slot.useSummary,
      description: slot.description ?? `ИИ-помощник: серия «${slot.seriesKey}» отпущена, время отдано приоритету руководителя.`,
    }),
  };
}

async function loadStand(leaderId: string, known: Set<string> | null): Promise<StandSnapshot> {
  const prefix = taskUnique(leaderId, '');
  const tracker = trackerConfig()
    ? await listOurIssues()
        .then((issues) => {
          const own = issues.filter((issue) => issue.unique.startsWith(prefix) && (!known || known.has(issue.unique))).map(({ key, summary, deadline }) => ({ key, summary, deadline }));
          return { ok: true, detail: `В Трекере ${own.length}`, issues: own };
        })
        .catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : 'Трекер не ответил', issues: [] }))
    : { ok: false, detail: 'Трекер не настроен', issues: [] };
  const calendar = calendarConfig()
    ? await ensureStandCalendar()
        .then(async (href) => {
          const events = (await listStandEvents(href))
            .filter((event) => event.uid.startsWith(`${leaderId}:`))
            .map(({ summary, start }) => ({ summary, start }));
          return { ok: true, detail: `В календаре «Стенд» ${events.length}`, events };
        })
        .catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : 'Календарь не ответил', events: [] }))
    : { ok: false, detail: 'Календарь не настроен', events: [] };
  return { tracker, calendar };
}

// После утверждения протокола: события всех встреч темы заново — цепочка, вопросы по прошлому протоколу, протокол встречи.
export async function refreshSeries(db: Db, leaderId: string, title: string): Promise<number> {
  if (!calendarConfig()) return 0;
  const [meetingRows, freedRows, subjectRows] = await Promise.all([
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
    db.select().from(freedSlots).where(eq(freedSlots.leaderId, leaderId)),
    db.select({ subject: emails.subject }).from(emails).where(eq(emails.leaderId, leaderId)),
  ]);
  const freed = new Set(freedRows.map((row) => row.meetingUid));
  const series = meetingRows.filter((row) => row.summary.toLowerCase() === title.toLowerCase() && !freed.has(row.uid));
  const notes = await seriesDescriptions(db, leaderId, series);
  const subjects = subjectRows.map((row) => row.subject);
  const href = await ensureStandCalendar();
  let written = 0;
  for (const meeting of series) {
    const event = meetingEvent(leaderId, meeting, subjects, notes.get(meeting.uid) ?? []);
    await putEvent(href, event.file, event.ics);
    written += 1;
  }
  cache.clear();
  return written;
}
