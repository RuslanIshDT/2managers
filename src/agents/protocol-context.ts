// Единый контекст темы встреч (T69): встречи одной темы (одинаковое название), их протоколы, задачи из протоколов и письма участников.
// Отсюда — вопросы по прошлому протоколу для нового протокола, цепочка темы в описании встреч и вопросы в утреннем сообщении.
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { mailIn, meetings, protocols, tasks } from '../db/schema.ts';
import { listQueueIssues, trackerConfig } from '../yandex/tracker.ts';
import { taskUnique } from './materials.ts';

export interface ProtocolRow {
  id: string;
  source: string;
  body: string;
  status: string;
  open: string[];
}

export interface SeriesMeeting {
  uid: string;
  summary: string;
  startsAt: string;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Встреча, по которой написан протокол: «2026-12-10T10-00 Планёрка направления-transcript.txt».
export function meetingOfFile(source: string): { title: string; startsAt: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2}) (.+?)-transcript\.txt$/.exec(source.trim());
  if (!match) return null;
  return { title: match[4].trim(), startsAt: `${match[1]}T${match[2]}:${match[3]}` };
}

export function whenWords(startsAt: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):?(\d{2})/.exec(startsAt);
  if (!match) return startsAt;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ''}, ${match[4]}:${match[5]}`;
}

// Протокол хранится с HTML-экранированием для Telegram; в календарь и в запрос модели — обычный текст.
export function plainBody(body: string): string {
  return body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function bodySection(body: string, title: string): string[] {
  const start = body.indexOf(`\n${title}`);
  if (start < 0) return [];
  const rest = body.slice(start + title.length + 1);
  const end = rest.search(/\n\n/);
  return (end < 0 ? rest : rest.slice(0, end))
    .split('\n')
    .map((line) => line.replace(/^—\s*/, '').trim())
    .filter(Boolean);
}

export async function leaderProtocols(db: Db, leaderId: string): Promise<ProtocolRow[]> {
  const rows = await db.select().from(protocols).where(eq(protocols.leaderId, leaderId)).orderBy(desc(protocols.createdAt));
  return rows
    .filter((row) => row.status !== 'отклонён')
    .map((row) => ({
      id: row.id,
      source: row.source,
      body: row.body,
      status: row.status,
      open: Array.isArray(row.openItems) ? row.openItems.filter((item): item is string => typeof item === 'string') : [],
    }));
}

// Прошлый протокол той же темы: последний по встрече раньше этой.
export function previousOf(rows: ProtocolRow[], meeting: { title: string; startsAt: string } | null): ProtocolRow | null {
  if (!meeting) return null;
  const same = rows
    .map((row) => ({ row, at: meetingOfFile(row.source) }))
    .filter((item) => item.at && item.at.title.toLowerCase() === meeting.title.toLowerCase() && item.at.startsAt < meeting.startsAt)
    .sort((a, b) => b.at!.startsAt.localeCompare(a.at!.startsAt));
  return same[0]?.row ?? null;
}

// Задачи из протокола со статусом: открыта ли она в Трекере (закрытая в Трекере — сделана).
export async function protocolTasks(db: Db, leaderId: string, protocolId: string, tracker?: Map<string, boolean> | null) {
  const rows = await db.select().from(tasks).where(eq(tasks.leaderId, leaderId));
  const own = rows
    .filter((row) => row.externalId.startsWith(`protocol-${protocolId}-`))
    .sort((a, b) => a.externalId.localeCompare(b.externalId, 'en', { numeric: true }));
  const states = tracker === undefined ? await trackerStates() : tracker;
  return own.map((row) => {
    const open = states?.get(taskUnique(leaderId, row.externalId));
    // Задача есть в Трекере — статус оттуда; нет (ещё не выложена или Трекер молчит) — из базы.
    const done = open === undefined ? /сделан|закрыт|отмен/i.test(row.status) : !open;
    return { externalId: row.externalId, title: row.title, owner: row.ownerName, dueOn: row.dueOn, done };
  });
}

// Задачи Трекера по ключу помощника: открыта или нет. Трекер не подключён или не ответил — null.
export async function trackerStates(): Promise<Map<string, boolean> | null> {
  if (!trackerConfig()) return null;
  try {
    const issues = await listQueueIssues();
    return new Map(issues.filter((issue) => issue.unique).map((issue) => [issue.unique, issue.open]));
  } catch {
    return null;
  }
}

// Письма участников встречи за неделю до неё — переписка по теме.
export async function participantLetters(db: Db, leaderId: string, meeting: { title: string; startsAt: string } | null) {
  if (!meeting) return [];
  const [rows, letters] = await Promise.all([
    db.select().from(meetings).where(and(eq(meetings.leaderId, leaderId), eq(meetings.summary, meeting.title))),
    db.select().from(mailIn).where(eq(mailIn.leaderId, leaderId)),
  ]);
  const found = rows.find((row) => row.startsAt === meeting.startsAt) ?? rows[0];
  const emails = new Set(
    (Array.isArray(found?.attendees) ? found.attendees : [])
      .map((item) => (item && typeof item === 'object' && 'email' in item && typeof item.email === 'string' ? item.email.toLowerCase() : ''))
      .filter(Boolean),
  );
  const day = meeting.startsAt.slice(0, 10);
  const from = shift(day, -7);
  const seen = new Set<string>();
  return letters
    .filter((row) => emails.has(row.fromEmail.toLowerCase()) && row.received.slice(0, 10) >= from && row.received.slice(0, 10) <= day)
    .sort((a, b) => a.received.localeCompare(b.received))
    .filter((row) => {
      const key = `${row.fromEmail}|${row.subject}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-15)
    .map((row) => ({ from: row.fromName, subject: row.subject, body: row.body.slice(0, 200), received: row.received }));
}

function shift(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// Что спросить по прошлому протоколу: открытые вопросы и шаги, задачи по которым не закрыты.
export function questionsOf(protocol: ProtocolRow, taskStates: { title: string; done: boolean }[]): string[] {
  // Неутверждённый протокол — только открытые вопросы: задач по нему ещё нет.
  const pending = protocol.status === 'утверждён' ? taskStates.filter((task) => !task.done).map((task) => `${task.title} — задача открыта`) : [];
  return [...protocol.open.map(plainBody), ...pending].slice(0, 10);
}

// Описание каждой встречи темы: где она в цепочке, вопросы по прошлому протоколу, её протокол, если утверждён.
export async function seriesDescriptions(db: Db, leaderId: string, rows: SeriesMeeting[]): Promise<Map<string, string[]>> {
  const all = await leaderProtocols(db, leaderId);
  const approved = all.filter((row) => row.status === 'утверждён');
  const open = approved.length ? await trackerStates() : null;
  const byTitle = new Map<string, SeriesMeeting[]>();
  for (const row of rows) byTitle.set(row.summary, [...(byTitle.get(row.summary) ?? []), row]);
  const out = new Map<string, string[]>();
  for (const [title, list] of byTitle) {
    const sorted = [...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (const [index, meeting] of sorted.entries()) {
      const lines: string[] = [];
      const prev = sorted[index - 1];
      const next = sorted[index + 1];
      const own = approved.find((row) => sameMeeting(row, meeting));
      const prevProtocol = prev ? approved.find((row) => sameMeeting(row, prev)) : undefined;
      if (sorted.length > 1) {
        const firstDecision = prevProtocol ? (bodySection(prevProtocol.body, 'Решения:').map(plainBody)[0] ?? '').replace(/\.$/, '') : '';
        lines.push(
          `Тема: ${title}. ${prev ? `Прошлая встреча: ${whenWords(prev.startsAt)}${prevProtocol ? `, протокол: ${firstDecision || 'утверждён'}` : ''}.` : 'Это первая встреча темы.'} ${next ? `Следующая: ${whenWords(next.startsAt)}.` : 'Следующей в календаре нет.'}`,
        );
      }
      if (prevProtocol) {
        const states = await protocolTasks(db, leaderId, prevProtocol.id, open);
        const questions = questionsOf(prevProtocol, states);
        if (questions.length) lines.push('', `Вопросы по прошлому протоколу (${whenWords(prev!.startsAt)}):`, ...questions.map((item) => `— ${item}`));
      }
      if (own) lines.push('', 'Протокол этой встречи (утверждён):', plainBody(own.body));
      if (lines.length) out.set(meeting.uid, lines);
    }
  }
  return out;
}

function sameMeeting(protocol: ProtocolRow, meeting: SeriesMeeting): boolean {
  const at = meetingOfFile(protocol.source);
  return Boolean(at && at.title.toLowerCase() === meeting.summary.toLowerCase() && at.startsAt === meeting.startsAt.slice(0, 16));
}

// Для утреннего сообщения: по каждой теме с протоколом — ближайшая встреча сегодня или завтра и вопросы к ней.
export async function morningQuestions(
  db: Db,
  leaderId: string,
  rows: { summary: string; startsAt: string }[],
  today: string,
  tomorrow: string,
): Promise<{ title: string; items: string[] }[]> {
  const all = await leaderProtocols(db, leaderId);
  if (!all.length) return [];
  const open = all.some((row) => row.status === 'утверждён') ? await trackerStates() : null;
  const latestByTitle = new Map<string, { row: ProtocolRow; at: { title: string; startsAt: string } }>();
  for (const row of all) {
    const at = meetingOfFile(row.source);
    if (!at) continue;
    const known = latestByTitle.get(at.title);
    if (!known || known.at.startsAt < at.startsAt) latestByTitle.set(at.title, { row, at });
  }
  const out: { title: string; items: string[] }[] = [];
  for (const { row, at } of latestByTitle.values()) {
    const items = questionsOf(row, await protocolTasks(db, leaderId, row.id, open));
    if (!items.length) continue;
    const upcoming = rows
      .filter((meeting) => meeting.summary.toLowerCase() === at.title.toLowerCase() && meeting.startsAt > at.startsAt)
      .map((meeting) => meeting.startsAt)
      .filter((startsAt) => startsAt.slice(0, 10) === today || startsAt.slice(0, 10) === tomorrow)
      .sort()[0];
    const day = upcoming ? (upcoming.slice(0, 10) === today ? 'сегодня' : 'завтра') : '';
    const note = row.status === 'утверждён' ? `протокол ${whenWords(at.startsAt).split(',')[0]}` : `протокол ${whenWords(at.startsAt).split(',')[0]} ещё не утверждён`;
    out.push({ title: upcoming ? `${at.title}, ${day} в ${upcoming.slice(11, 16)} (${note})` : `${at.title} (${note})`, items });
  }
  return out;
}
