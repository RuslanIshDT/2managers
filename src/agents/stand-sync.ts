// Кладёт задачи и встречи руководителя в Трекер и в календарь «Стенд». Повтор не плодит копии.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { emails, meetings, protocols, tasks } from '../db/schema.ts';
import { calendarConfig, ensureStandCalendar, listStandEvents, putEvent } from '../yandex/calendar.ts';
import { createIssue, listOurIssues, trackerConfig } from '../yandex/tracker.ts';
import { attendeeNames, eventFile, issueDraft, meetingStart, relatedSubjects, standEvent, taskUnique } from './materials.ts';
import { releaseFor } from './protocol.ts';

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
  let created = 0;
  let existed = 0;
  let trackerFailed = 0;
  if (trackerConfig()) {
    for (const task of taskRows) {
      const draft = issueDraft(task, relatedSubjects(task.title, subjects));
      try {
        const result = await createIssue({ unique: taskUnique(leaderId, task.externalId), ...draft });
        if (result === 'created') created += 1;
        else existed += 1;
      } catch {
        trackerFailed += 1;
      }
    }
  }
  let written = 0;
  let calendarFailed = 0;
  if (calendarConfig()) {
    const href = await ensureStandCalendar();
    for (const meeting of meetingRows) {
      const names = attendeeNames(meeting.attendees);
      const near = relatedSubjects(meeting.summary, subjects);
      const description = [
        names.length ? `Участники: ${names.join(', ')}.` : '',
        meeting.organizer ? `Организатор: ${meeting.organizer}.` : '',
        near.length ? `Рядом в почте: ${near.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const start = meetingStart(meeting.startsAt);
      const ics = standEvent({
        uid: `${leaderId}:${meeting.uid}`,
        start,
        minutes: meeting.minutes,
        summary: meeting.summary,
        description,
      });
      try {
        await putEvent(href, eventFile(`${leaderId}:${meeting.uid}`), ics);
        written += 1;
      } catch {
        calendarFailed += 1;
      }
    }
    for (const row of protocolRows) {
      if (row.status !== 'утверждён') continue;
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
