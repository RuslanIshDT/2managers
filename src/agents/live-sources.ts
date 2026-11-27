// Задачи и встречи для утреннего сообщения — из Яндекс Трекера и календаря «Стенд» (владелец 27.11.2026, T65).
// Задачи и встречи материалов туда выкладывает помощник; поставленные руками — тоже берутся.
// Трекер или календарь не ответили — берётся база системы, и сообщение говорит об этом.
import { isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { leaders } from '../db/schema.ts';
import { listQueueIssues, trackerConfig, type QueueIssue } from '../yandex/tracker.ts';
import { calendarConfig, ensureStandCalendar, listStandMeetings } from '../yandex/calendar.ts';
import { taskUnique } from './materials.ts';

export interface LiveTask {
  id: string;
  title: string;
  owner: string;
  dueOn: string;
  status: string;
}

export interface LiveMeeting {
  uid: string;
  summary: string;
  startsAt: string;
  minutes: number;
  goal?: boolean;
}

export interface LiveSources {
  tasks: LiveTask[] | null;
  meetings: LiveMeeting[] | null;
  notes: string[];
}

// Трекер, календарь и ящик стенда принадлежат руководителю, к которому привязан Telegram (как ящик в опросе почты).
export async function standOwner(db: Db): Promise<string | undefined> {
  const rows = await db.select({ id: leaders.id }).from(leaders).where(isNotNull(leaders.telegramChatId));
  return rows[0]?.id;
}

// Задача помощника несёт свой ключ с id руководителя и строку «Исполнитель: …».
// Задача, поставленная руками (без ключа помощника), — задача владельца стенда, исполнитель — он сам, если не указан другой.
export function tasksFromIssues(issues: QueueIssue[], leaderId: string, leaderName: string, isOwner: boolean): LiveTask[] {
  const prefix = taskUnique(leaderId, '');
  return issues.flatMap((issue) => {
    if (!issue.open) return [];
    const ours = issue.unique.startsWith('ecompras-');
    if (ours && !issue.unique.startsWith(prefix)) return [];
    if (!ours && !isOwner) return [];
    const named = /Исполнитель:\s*([^.\n]+)/.exec(issue.description)?.[1]?.trim();
    return [{ id: issue.key, title: issue.summary, owner: named || leaderName, dueOn: issue.deadline, status: issue.status }];
  });
}

// Событие помощника — UID с id руководителя впереди; блок освобождённого времени — «<id>:free:». Событие без такого UID — владельца стенда.
export function meetingsFromEvents(
  events: { uid: string; summary: string; startsAt: string; minutes: number }[],
  leaderId: string,
  leaderIds: string[],
  isOwner: boolean,
): LiveMeeting[] {
  return events.flatMap((event) => {
    const holder = leaderIds.find((id) => event.uid.startsWith(`${id}:`));
    if (holder ? holder !== leaderId : !isOwner) return [];
    return [{ ...event, goal: event.uid.startsWith(`${leaderId}:free:`) }];
  });
}

export async function liveSources(db: Db, leaderId: string, leaderName: string): Promise<LiveSources> {
  const [owner, leaderRows] = await Promise.all([standOwner(db), db.select({ id: leaders.id }).from(leaders)]);
  const isOwner = owner === leaderId;
  const notes: string[] = [];
  let tasks: LiveTask[] | null = null;
  if (!trackerConfig()) notes.push('Трекер не подключён — задачи взяты из базы системы.');
  else {
    try {
      tasks = tasksFromIssues(await listQueueIssues(), leaderId, leaderName, isOwner);
    } catch (error) {
      notes.push(`Трекер не ответил (${error instanceof Error ? error.message : 'ошибка'}) — задачи взяты из базы системы.`);
    }
  }
  let meetings: LiveMeeting[] | null = null;
  if (!calendarConfig()) notes.push('Календарь не подключён — встречи взяты из базы системы.');
  else {
    try {
      const events = await listStandMeetings(await ensureStandCalendar());
      meetings = meetingsFromEvents(events, leaderId, leaderRows.map((row) => row.id), isOwner);
    } catch (error) {
      notes.push(`Календарь не ответил (${error instanceof Error ? error.message : 'ошибка'}) — встречи взяты из базы системы.`);
    }
  }
  return { tasks, meetings, notes };
}
