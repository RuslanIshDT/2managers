// Протокол по расшифровке. Текст встречи в репозиторий не входит: его читает стенд с диска.
// После «Утвердить» протокол уходит в тестовый ящик, задачи пишутся в базу и в Трекер, встреча — в календарь «Стенд» и файлом .ics.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { leaders, meetings, people, protocols, tasks } from '../db/schema.ts';
import { clockFor } from './scene.ts';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';
import { mailConfig, sendMail } from '../mail.ts';
import { sendMessage } from '../telegram.ts';
import { calendarConfig } from '../yandex/calendar.ts';
import { publishApproved } from '../yandex/publish.ts';
import { trackerConfig } from '../yandex/tracker.ts';

const MAX_TRANSCRIPT = 12_000;

export interface ProtocolDraft {
  theme: string;
  participants: string[];
  notes: string[];
  decisions: string[];
  next: string[];
  proposals: string[];
  open: string[];
}

const draftZod = z.object({
  theme: z.string().min(1),
  participants: z.array(z.string()),
  notes: z.array(z.string()),
  decisions: z.array(z.string()),
  next: z.array(z.string()),
  proposals: z.array(z.string()),
  open: z.array(z.string()),
});

function clip(items: string[], count: number): string[] {
  return items.map((item) => item.trim()).filter(Boolean).slice(0, count).map((item) => item.slice(0, 240));
}

const schema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['theme', 'participants', 'notes', 'decisions', 'next', 'proposals', 'open'],
  properties: {
    theme: { type: 'string' },
    participants: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    next: { type: 'array', items: { type: 'string' } },
    proposals: { type: 'array', items: { type: 'string' } },
    open: { type: 'array', items: { type: 'string' } },
  },
};

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderProtocol(draft: ProtocolDraft): string {
  const lines = [
    esc(draft.theme),
    '',
    `Участники: ${draft.participants.map(esc).join(', ') || 'не названы'}.`,
    '',
    'Заметки:',
    ...draft.notes.map((item) => `— ${esc(item)}`),
    '',
    'Решения:',
    ...draft.decisions.map((item) => `— ${esc(item)}`),
    '',
    'Дальше:',
    ...draft.next.map((item) => `— ${esc(item)}`),
    '',
    'Предложения помощника:',
    ...draft.proposals.map((item) => `— ${esc(item)}`),
  ];
  if (draft.open.length) {
    lines.push('', 'Открытые вопросы:', ...draft.open.map((item) => `— ${esc(item)}`));
  }
  return lines.join('\n').slice(0, 4000);
}

export function parseProtocolCallback(data: string): string | null {
  const match = /^p:approve:([a-f0-9]{8})$/.exec(data);
  return match ? match[1] : null;
}

export function protocolCallback(id: string): string {
  return `p:approve:${id}`;
}

export async function protocolCard(db: Db, leaderId: string) {
  const row = await latestProtocol(db, leaderId);
  if (!row) return null;
  const minutes = row.transcriptAt && row.sentAt ? preparationMinutes(row.transcriptAt, row.sentAt) : null;
  return { status: row.status, open: row.open.length, preparation: preparationWords(minutes) };
}

export async function latestProtocol(db: Db, leaderId: string) {
  const rows = await db.select().from(protocols).where(eq(protocols.leaderId, leaderId)).orderBy(desc(protocols.createdAt)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const open = Array.isArray(row.openItems) ? row.openItems.filter((item): item is string => typeof item === 'string') : [];
  return { id: row.id, source: row.source, body: row.body, open, status: row.status, transcriptAt: row.transcriptAt, sentAt: row.sentAt };
}

export function preparationMinutes(arrived: Date, sent: Date): number {
  return Math.max(0, Math.round((sent.getTime() - arrived.getTime()) / 60_000));
}

export function preparationWords(minutes: number | null): string {
  if (minutes === null) return 'Время подготовки не записано';
  if (minutes < 1) return 'Подготовка: меньше минуты';
  return `Подготовка: ${minutes} мин`;
}

export function morningOpenItems(open: string[]): string {
  if (!open.length) return '';
  return ['', 'Открытые вопросы прошлого протокола:', ...open.map((item) => `— ${esc(item)}`)].join('\n');
}

export interface NextMeeting {
  uid: string;
  startsAt: string;
  minutes: number;
  summary: string;
}

export interface KnownPerson {
  name: string;
  email: string;
}

// Встреча, по которой написана расшифровка: «2026-12-10T10-00 Планёрка направления-transcript.txt».
export function meetingOfSource(source: string): { title: string; startsAt: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2}) (.+?)-transcript\.txt$/.exec(source.trim());
  if (!match) return null;
  return { title: match[4].trim(), startsAt: `${match[1]}T${match[2]}:${match[3]}` };
}

// Следующая встреча той же серии в календаре руководителя: на ней проверяются открытые вопросы.
export function nextOfSeries(
  meeting: { title: string; startsAt: string } | null,
  rows: { uid: string; startsAt: string; minutes: number; summary: string }[],
): NextMeeting | null {
  if (!meeting) return null;
  const later = rows
    .filter((row) => row.summary.trim().toLowerCase() === meeting.title.toLowerCase() && row.startsAt > meeting.startsAt)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const row = later[0];
  return row ? { uid: row.uid, startsAt: row.startsAt, minutes: row.minutes, summary: row.summary } : null;
}

export function protocolRelease(
  body: string,
  known: KnownPerson[],
  at: Date,
  id = 'protocol',
  next: NextMeeting | null = null,
  meetingDay = '',
  leaderId = '',
): ProtocolRelease {
  const theme = body.split('\n')[0]?.trim() || 'Встреча по протоколу';
  const participants = participantNames(body);
  const steps = sectionLines(body, 'Дальше:').map((line) => line.replace(/^—\s*/, '').trim()).filter(Boolean);
  const open = sectionLines(body, 'Открытые вопросы:').map((line) => line.replace(/^—\s*/, '').trim()).filter(Boolean);
  const when = next ? meetingStartAt(next.startsAt) : followUpStart(at);
  const minutes = next && next.minutes > 0 ? next.minutes : 30;
  const fallbackDue = moscowDate(when);
  const year = (meetingDay || fallbackDue).slice(0, 4);
  const tasks = steps.map((title) => ({
    title: title.slice(0, 240),
    owner: ownerOf(title, participants, known),
    dueOn: dueOf(title, meetingDay, year) ?? fallbackDue,
  }));
  const named = participants.map((name) => {
    const person = known.find((row) => row.name.toLowerCase() === name.toLowerCase() && row.email.trim());
    return person ? `${name} <${person.email}>` : name;
  });
  const meetingTitle = next ? next.summary : theme;
  const agenda = [
    open.length ? `Открытые вопросы прошлого протокола: ${open.join('; ')}.` : '',
    steps.length ? `Шаги: ${steps.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const text = [
    named.length ? `Кому: ${named.join('; ')}.` : 'Кому: участники в протоколе не названы.',
    'Адреса из каталога писем не принимают, поэтому письмо ушло в тестовый ящик. Настоящие адресаты названы выше.',
    'Календарь не подключён: приглашение на встречу во вложении.',
    '',
    body.replace(/\nРассылка участникам — заглушка, письма не уходят\./g, '').trim(),
    '',
    next
      ? `Следующая встреча: ${meetingTitle}, ${dayWords(moscowDate(when))}, ${moscowTime(when)} по Москве. В повестке — открытые вопросы этого протокола.`
      : `Встреча: ${theme}. ${dayWords(fallbackDue)}, ${moscowTime(when)} по Москве, ${minutes} минут.`,
  ].join('\n');
  const uid = next && leaderId ? `${leaderId}:${next.uid}` : `protocol-${id}`;
  return {
    subject: `Протокол: ${theme}`.slice(0, 180),
    text,
    tasks,
    ics: next && leaderId
      ? invitation({ uid, start: when, minutes, summary: meetingTitle, description: agenda }).replace(`UID:${uid}@ecompras`, `UID:${uid}`)
      : invitation({ uid, start: when, minutes, summary: meetingTitle, description: agenda || steps.join('\n') }),
    when,
    eventUid: next && leaderId ? `${leaderId}:${next.uid}` : '',
  };
}

export async function releaseFor(db: Db, leaderId: string, row: { id: string; body: string; source: string; createdAt: Date }) {
  const [known, meetingRows] = await Promise.all([
    db.select({ name: people.name, email: people.email }).from(people).where(eq(people.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
  ]);
  const meeting = meetingOfSource(row.source);
  const next = nextOfSeries(meeting, meetingRows.map((item) => ({ uid: item.uid, startsAt: item.startsAt, minutes: item.minutes, summary: item.summary })));
  return protocolRelease(row.body, known, clockFor(leaderId, row.createdAt).now, row.id, next, meeting?.startsAt.slice(0, 10) ?? '', leaderId);
}

export async function approveProtocol(db: Db, id: string, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const [row] = await db.select().from(protocols).where(eq(protocols.id, id)).limit(1);
  if (!row || row.leaderId !== leader.id) return 'Протокол не найден';
  if (row.status === 'утверждён') return 'Уже утверждён';
  const mailbox = mailConfig();
  if (!mailbox) return 'Яндекс Почта не настроена';
  const release = await releaseFor(db, leader.id, row);
  for (const [index, task] of release.tasks.entries()) {
    await db
      .insert(tasks)
      .values({
        leaderId: leader.id,
        externalId: `protocol-${row.id}-${index + 1}`,
        title: task.title,
        ownerName: task.owner,
        dueOn: task.dueOn,
        status: 'в работе',
        source: 'протокол',
      })
      .onConflictDoNothing();
  }
  let text = release.text;
  let placed = false;
  if (calendarConfig()) {
    try {
      await publishApproved(leader.id, [], {
        uid: release.eventUid || `${leader.id}:protocol-${row.id}`,
        ics: release.eventUid ? release.ics : release.ics.replace(/^UID:.*$/m, `UID:${leader.id}:protocol-${row.id}@ecompras`),
      });
      placed = true;
    } catch {
      placed = false;
    }
  }
  if (placed) {
    text = text.replace(
      'Календарь не подключён: приглашение на встречу во вложении.',
      'Приглашение на встречу во вложении. Та же встреча стоит в календаре «Стенд».',
    );
  }
  await sendMail(mailbox.user, release.subject, text, [
    { filename: 'vstrecha.ics', content: release.ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' },
  ]);
  await db.update(protocols).set({ status: 'утверждён' }).where(eq(protocols.id, row.id));
  let trackerNote = '';
  if (trackerConfig()) {
    try {
      const note = await publishApproved(
        leader.id,
        release.tasks.map((task, index) => ({
          externalId: `protocol-${row.id}-${index + 1}`,
          title: task.title,
          ownerName: task.owner,
          dueOn: task.dueOn,
          status: 'в работе',
          source: 'протокол',
        })),
        null,
      );
      trackerNote = ` ${note}`;
    } catch {
      trackerNote = ' Трекер задачи не принял.';
    }
  }
  const count = release.tasks.length;
  return `Протокол утверждён. Письмо с приглашением ушло в тестовый ящик, задач записано: ${count}.${trackerNote}`;
}

function participantNames(body: string): string[] {
  const line = sectionLines(body, 'Участники:')[0] ?? '';
  return line
    .replace(/^Участники:\s*/i, '')
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((name) => name.replace(/\.$/, '').trim())
    .filter((name) => name.length > 1);
}

function sectionLines(body: string, title: string): string[] {
  const start = body.indexOf(title);
  if (start < 0) return [];
  const rest = body.slice(start + title.length);
  const next = rest.search(/\n\n/);
  const block = next < 0 ? rest : rest.slice(0, next);
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// Исполнитель — человек из оргструктуры руководителя: полное имя в шаге, иначе имя или фамилия, если они однозначны.
export function ownerOf(title: string, participants: string[], known: KnownPerson[] = []): string {
  const text = title.toLowerCase();
  const full = [...known.map((row) => row.name), ...participants].filter((name) => name && text.includes(name.toLowerCase()));
  full.sort((a, b) => b.length - a.length);
  if (full[0]) return full[0];
  const words = new Set(text.replace(/ё/g, 'е').split(/[^a-zа-я]+/i).filter(Boolean));
  const hits = known.filter((row) =>
    row.name
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/\s+/)
      .some((part) => part.length >= 3 && words.has(part)),
  );
  return hits.length === 1 ? hits[0].name : 'не назван';
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Срок из шага: «до 14 декабря», «до 14.12», «сегодня» — день встречи.
export function dueOf(step: string, meetingDay: string, year: string): string | null {
  const text = step.toLowerCase();
  const found: string[] = [];
  for (const match of text.matchAll(/(?:до|к)\s+(\d{1,2})\s+([а-я]+)/g)) {
    const month = MONTHS.indexOf(match[2]);
    if (month >= 0) found.push(`${year}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`);
  }
  for (const match of text.matchAll(/(?:до|к)\s+(\d{1,2})\.(\d{1,2})/g)) {
    found.push(`${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`);
  }
  if (meetingDay && /сегодня/.test(text)) found.push(meetingDay);
  found.sort();
  return found[0] ?? null;
}

function meetingStartAt(value: string): Date {
  const [date, time = '10:00'] = value.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, (hh || 0) - 3, mm || 0));
}

function moscowTime(at: Date): string {
  return new Date(at.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function dayWords(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1] ?? ''}`.trim();
}

export function followUpStart(at: Date): Date {
  const moscow = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  const day = moscow.getUTCDay();
  const add = day === 1 ? 7 : (8 - day) % 7;
  return new Date(Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate() + add, 7, 0, 0));
}

function moscowDate(at: Date): string {
  const moscow = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  const month = String(moscow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(moscow.getUTCDate()).padStart(2, '0');
  return `${moscow.getUTCFullYear()}-${month}-${day}`;
}

function invitation(input: { uid: string; start: Date; minutes?: number; summary: string; description: string }): string {
  const end = new Date(input.start.getTime() + (input.minutes ?? 30) * 60 * 1000);
  const stamp = icsTime(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ecompras//protocol//RU',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${input.uid}@ecompras`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsTime(input.start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(input.summary)}`,
    `DESCRIPTION:${icsText(input.description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

function icsTime(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (char) => `\\${char}`).slice(0, 400);
}

interface ProtocolRelease {
  subject: string;
  text: string;
  tasks: { title: string; owner: string; dueOn: string }[];
  ics: string;
  when: Date;
  eventUid: string;
}

// Расшифровки лежат в каталоге руководителя (data/<руководитель>/meetings). Берётся последняя встреча по имени файла.
async function latestTranscript(dir: string): Promise<{ name: string; text: string }> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('-transcript.txt'));
  } catch {
    names = [];
  }
  if (!names.length) throw new Error('В каталоге руководителя нет расшифровок встреч');
  names.sort((a, b) => b.localeCompare(a));
  const picked = names[0];
  const text = await readFile(join(dir, picked), 'utf8');
  return { name: picked, text: text.slice(0, MAX_TRANSCRIPT) };
}

export async function writeProtocol(db: Db, leaderId: string, dir = `data/${leaderId}/meetings`): Promise<{ id: string }> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader?.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
  const arrived = new Date();
  const source = await latestTranscript(dir);
  const meeting = meetingOfSource(source.name);
  const staff = await db.select({ name: people.name, position: people.position }).from(people).where(eq(people.leaderId, leaderId));
  const result = await withLlmScope(
    { agent: 'protocol', leaderId, operationId: `protocol:${leaderId}:${Date.now()}`, title: 'Протокол встречи' },
    () => callJson<unknown>({
    purpose: `protocol:${leaderId}`,
    system: [
      'Ты пишешь протокол встречи по расшифровке.',
      'Тема, участники, короткие заметки, решения, дальнейшие шаги, предложения помощника и открытые вопросы.',
      'Не выдумывай людей и решений, которых нет в тексте. Каждый пункт короче 250 знаков.',
      'Участников называй полным именем из списка людей руководителя. Каждый дальнейший шаг начинай с полного имени ответственного, срок пиши датой: «до 14 декабря»; «сегодня» — это день встречи. Шагов не больше 12: у каждого, кому на встрече дали поручение, есть свой шаг, мелкие поручения одному человеку объединяй.',
    ].join(' '),
    user: [
      meeting ? `Встреча: ${meeting.title}, ${meeting.startsAt.replace('T', ' ')} по Москве.` : '',
      `Люди руководителя: ${staff.map((row) => `${row.name} (${row.position})`).join('; ')}.`,
      '',
      source.text,
    ].join('\n'),
    schemaName: 'protocol',
    schema,
  }),
  );
  const parsed = draftZod.safeParse(result.data);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join('; ');
    throw new Error(`Ответ модели не совпал со схемой протокола: ${detail}`.slice(0, 200));
  }
  const draft: ProtocolDraft = {
    theme: parsed.data.theme.trim().slice(0, 180),
    participants: clip(parsed.data.participants, 12),
    notes: clip(parsed.data.notes, 5),
    decisions: clip(parsed.data.decisions, 6),
    next: clip(parsed.data.next, 12),
    proposals: clip(parsed.data.proposals, 3),
    open: clip(parsed.data.open, 5),
  };
  const id = randomUUID().replace(/-/g, '').slice(0, 8);
  const body = renderProtocol(draft);
  await db.insert(protocols).values({
    id,
    leaderId,
    source: source.name,
    body,
    openItems: draft.open,
    status: 'ждёт',
    transcriptAt: arrived,
    createdAt: new Date(),
  });
  await sendMessage(body, leader.telegramChatId, {
    reply_markup: { inline_keyboard: [[{ text: 'Утвердить', callback_data: protocolCallback(id) }]] },
  });
  const sentAt = new Date();
  await db.update(protocols).set({ sentAt }).where(eq(protocols.id, id));
  return { id };
}
