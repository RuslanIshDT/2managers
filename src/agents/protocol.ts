// Протокол по расшифровке. Текст встречи в репозиторий не входит: его читает стенд с диска.
// Модель видит прошлый протокол той же темы, задачи из него и письма участников (T69) и пишет, что с прошлыми решениями.
// В Telegram — «Утвердить», «Поправить», «Отклонить». После «Утвердить»: задачи — в базу и Трекер, протокол — в описание встречи
// в календаре «Стенд», у встреч темы — цепочка и вопросы по прошлому протоколу, письмо с протоколом и .ics — в тестовый ящик.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { leaders, meetings, people, protocols, revisions, tasks } from '../db/schema.ts';
import { clockFor } from './scene.ts';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';
import { mailConfig, sendMail } from '../mail.ts';
import { sendMessage } from '../telegram.ts';
import { calendarConfig, ensureStandCalendar, putEvent } from '../yandex/calendar.ts';
import { publishApproved } from '../yandex/publish.ts';
import { refreshSeries } from './stand-sync.ts';
import { leaderProtocols, participantLetters, plainBody, previousOf, protocolTasks, whenWords } from './protocol-context.ts';
import { commentIssue, listQueueIssues, moveIssue, trackerConfig } from '../yandex/tracker.ts';
import { eventFile, meetingStart, standEvent, taskUnique } from './materials.ts';
import {
  cleanMeetings,
  cleanPrior,
  cleanSteps,
  openWithMeetings,
  priorEffects,
  priorLine,
  letterKey,
  lettersToSend,
  mailResultLine,
  protocolLetters,
  protocolPlace,
  protocolTaskDescription,
  storedMailed,
  scheduledMeetings,
  stepLine,
  storedMeetings,
  storedPrior,
  storedSteps,
  type AgreedMeeting,
  type PriorItem,
  type ProtocolStep,
} from './protocol-steps.ts';

const MAX_TRANSCRIPT = 12_000;

export interface ProtocolDraft {
  theme: string;
  participants: string[];
  previous: string[];
  notes: string[];
  decisions: string[];
  next: string[];
  steps?: ProtocolStep[];
  proposals: string[];
  open: string[];
  prior?: PriorItem[];
  agreed?: AgreedMeeting[];
}

const draftZod = z.object({
  theme: z.string().min(1),
  participants: z.array(z.string()),
  notes: z.array(z.string()),
  decisions: z.array(z.string()),
  steps: z.array(z.object({ owner: z.string(), task: z.string(), due: z.string() })),
  proposals: z.array(z.string()),
  open: z.array(z.string()),
  prior: z.array(z.object({ n: z.coerce.number(), status: z.string(), note: z.string() })),
  meetings: z.array(z.object({ title: z.string(), date: z.string(), time: z.string(), participants: z.array(z.string()) })),
});

function clip(items: string[], count: number): string[] {
  return items.map((item) => item.trim()).filter(Boolean).slice(0, count).map((item) => item.slice(0, 240));
}

const stepSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['owner', 'task', 'due'],
  properties: { owner: { type: 'string' }, task: { type: 'string' }, due: { type: 'string' } },
};
const priorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['n', 'status', 'note'],
  properties: { n: { type: 'integer' }, status: { type: 'string' }, note: { type: 'string' } },
};
const meetingSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'date', 'time', 'participants'],
  properties: {
    title: { type: 'string' },
    date: { type: 'string' },
    time: { type: 'string' },
    participants: { type: 'array', items: { type: 'string' } },
  },
};
const schema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['theme', 'participants', 'notes', 'decisions', 'steps', 'proposals', 'open', 'prior', 'meetings'],
  properties: {
    theme: { type: 'string' },
    participants: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: stepSchema },
    proposals: { type: 'array', items: { type: 'string' } },
    open: { type: 'array', items: { type: 'string' } },
    prior: { type: 'array', items: priorSchema },
    meetings: { type: 'array', items: meetingSchema },
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
    ...(draft.previous.length ? ['Что с прошлыми решениями:', ...draft.previous.map((item) => `— ${esc(item)}`), ''] : []),
    'Заметки:',
    ...draft.notes.map((item) => `— ${esc(item)}`),
    '',
    'Решения:',
    ...draft.decisions.map((item) => `— ${esc(item)}`),
    '',
    'Дальше:',
    ...((draft.steps ?? []).length ? (draft.steps ?? []).map((item) => `— ${esc(stepLine(item))}`) : draft.next.map((item) => `— ${esc(item)}`)),
    '',
    'Предложения помощника:',
    ...draft.proposals.map((item) => `— ${esc(item)}`),
  ];
  if (draft.open.length) {
    lines.push('', 'Открытые вопросы:', ...draft.open.map((item) => `— ${esc(item)}`));
  }
  return lines.join('\n').slice(0, 8000);
}

// Telegram принимает до 4096 знаков: длинный протокол уходит частями по строкам, кнопки — у последней части.
export function messageParts(text: string, limit = 3900): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > limit) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line.slice(0, limit);
  }
  if (current) parts.push(current);
  return parts;
}

async function sendProtocol(body: string, chatId: string, id: string) {
  const parts = messageParts(body);
  for (const [index, part] of parts.entries()) {
    await sendMessage(part, chatId, index === parts.length - 1 ? { reply_markup: protocolKeyboard(id) } : undefined);
  }
}

export type ProtocolAction = 'approve' | 'edit' | 'reject';

export function parseProtocolCallback(data: string): { action: ProtocolAction; id: string } | null {
  const match = /^p:(approve|edit|reject):([a-f0-9]{8})$/.exec(data);
  return match ? { action: match[1] as ProtocolAction, id: match[2] } : null;
}

export function protocolCallback(id: string, action: ProtocolAction = 'approve'): string {
  return `p:${action}:${id}`;
}

export function protocolKeyboard(id: string) {
  return {
    inline_keyboard: [
      [{ text: 'Утвердить', callback_data: protocolCallback(id, 'approve') }],
      [
        { text: 'Поправить', callback_data: protocolCallback(id, 'edit') },
        { text: 'Отклонить', callback_data: protocolCallback(id, 'reject') },
      ],
    ],
  };
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
  structured: ProtocolStep[] = [],
): ProtocolRelease {
  const theme = body.split('\n')[0]?.trim() || 'Встреча по протоколу';
  const participants = participantNames(body);
  const steps = sectionLines(body, 'Дальше:').map((line) => line.replace(/^—\s*/, '').trim()).filter(Boolean);
  const open = sectionLines(body, 'Открытые вопросы:').map((line) => line.replace(/^—\s*/, '').trim()).filter(Boolean);
  const when = next ? meetingStartAt(next.startsAt) : followUpStart(at);
  const minutes = next && next.minutes > 0 ? next.minutes : 30;
  const fallbackDue = moscowDate(when);
  const year = (meetingDay || fallbackDue).slice(0, 4);
  // Новые протоколы — из структуры. Старые, где шаги ещё строками текста, читаются по-прежнему.
  const tasks = structured.length
    ? structured.map((step) => ({ title: step.task, owner: step.owner, dueOn: step.due }))
    : steps.map((title) => ({
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

export async function releaseFor(db: Db, leaderId: string, row: { id: string; body: string; source: string; createdAt: Date; steps?: unknown }) {
  const [known, meetingRows] = await Promise.all([
    db.select({ name: people.name, email: people.email }).from(people).where(eq(people.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
  ]);
  const meeting = meetingOfSource(row.source);
  const next = nextOfSeries(meeting, meetingRows.map((item) => ({ uid: item.uid, startsAt: item.startsAt, minutes: item.minutes, summary: item.summary })));
  return protocolRelease(row.body, known, clockFor(leaderId, row.createdAt).now, row.id, next, meeting?.startsAt.slice(0, 10) ?? '', leaderId, storedSteps(row.steps));
}

async function outgoingFor(
  db: Db,
  leader: { id: string; name: string },
  row: { id: string; body: string; source: string; createdAt: Date; steps?: unknown },
) {
  const release = await releaseFor(db, leader.id, row);
  const meeting = meetingOfSource(row.source);
  const known = await db.select({ name: people.name, email: people.email }).from(people).where(eq(people.leaderId, leader.id));
  const letters = protocolLetters({
    theme: plainBody(row.body).split('\n')[0]?.trim() || 'Встреча',
    body: row.body,
    tasks: release.tasks,
    participants: participantNames(plainBody(row.body)),
    known,
    leaderName: leader.name,
    place: protocolPlace(meeting),
  });
  return { release, meeting, known, letters };
}

async function sendProtocolLetters(
  db: Db,
  id: string,
  mailboxUser: string,
  letters: { toName: string; subject: string; text: string }[],
  ics: string,
  mailed: string[],
): Promise<{ mailed: string[]; failed: string[] }> {
  const sent = new Set(mailed);
  const failed: string[] = [];
  let next = [...mailed];
  const attachment = [{ filename: 'vstrecha.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' }];
  for (const letter of letters) {
    const key = letterKey(letter.toName);
    if (sent.has(key)) continue;
    try {
      await sendMail(mailboxUser, letter.subject, letter.text, attachment);
      next = [...next, key];
      sent.add(key);
      await db.update(protocols).set({ mailed: next }).where(eq(protocols.id, id));
    } catch (err) {
      console.error('Письмо протокола не ушло', err instanceof Error ? err.message : err);
      failed.push(letter.toName);
    }
  }
  return { mailed: next, failed };
}

export async function approveProtocol(db: Db, id: string, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const [row] = await db.select().from(protocols).where(eq(protocols.id, id)).limit(1);
  if (!row || row.leaderId !== leader.id) return 'Протокол не найден';
  if (row.status === 'утверждён') {
    const mailed = storedMailed(row.mailed);
    if (!mailed) return 'Уже утверждён';
    const outgoing = await outgoingFor(db, leader, row);
    const pending = lettersToSend(outgoing.letters, mailed);
    if (!pending.length) return 'Уже утверждён';
    const mailbox = mailConfig();
    if (!mailbox) return 'Яндекс Почта не настроена';
    const result = await sendProtocolLetters(db, row.id, mailbox.user, pending, outgoing.release.ics, mailed);
    return mailResultLine({ sent: result.mailed.length - mailed.length, total: outgoing.letters.length, failed: result.failed, again: true });
  }
  const mailbox = mailConfig();
  if (!mailbox) return 'Яндекс Почта не настроена';
  const outgoing = await outgoingFor(db, leader, row);
  const emailOf = new Map(outgoing.known.map((person) => [person.name.toLowerCase(), person.email]));
  const taskRows = outgoing.release.tasks.map((task, index) => ({
    externalId: `protocol-${row.id}-${index + 1}`,
    title: task.title,
    ownerName: task.owner,
    ownerEmail: emailOf.get(task.owner.toLowerCase()) ?? '',
    dueOn: task.dueOn,
    status: 'в работе',
    source: 'протокол',
    description: protocolTaskDescription(task.owner, outgoing.meeting),
  }));
  for (const task of taskRows) {
    await db
      .insert(tasks)
      .values({ leaderId: leader.id, externalId: task.externalId, title: task.title, ownerName: task.ownerName, dueOn: task.dueOn, status: task.status, source: task.source })
      .onConflictDoNothing();
  }
  // Задачи — в Трекер до календаря: в описании встреч темы статус задач берётся из Трекера.
  let trackerNote = '';
  if (trackerConfig()) {
    try {
      trackerNote = ` ${await publishApproved(leader.id, taskRows, null)}`;
    } catch {
      trackerNote = ' Трекер задачи не принял.';
    }
  }
  const priorNote = await applyPrior(db, leader.id, row);
  // Статус — до календаря: описание встреч темы строится из утверждённых протоколов.
  // Пустой список отправки пишется сразу: сбой письма не выглядит как «уже всё ушло».
  await db.update(protocols).set({ status: 'утверждён', awaitingEdit: false, mailed: [] }).where(eq(protocols.id, row.id));
  let placed = false;
  if (calendarConfig()) {
    try {
      if (outgoing.meeting) await refreshSeries(db, leader.id, outgoing.meeting.title);
      else
        await publishApproved(leader.id, [], {
          uid: `${leader.id}:protocol-${row.id}`,
          ics: outgoing.release.ics.replace(/^UID:.*$/m, `UID:${leader.id}:protocol-${row.id}@ecompras`),
        });
      placed = true;
    } catch (err) {
      console.error('Календарь не обновлён', err instanceof Error ? err.message : err);
      placed = false;
    }
  }
  const createdMeetings = await placeAgreed(leader.id, row.id, storedMeetings(row.agreed));
  const result = await sendProtocolLetters(db, row.id, mailbox.user, outgoing.letters, outgoing.release.ics, []);
  const parts = [
    'Протокол утверждён.',
    placed ? 'Он в описании встречи в календаре.' : '',
    mailResultLine({ sent: result.mailed.length, total: outgoing.letters.length, failed: result.failed, again: false }),
    `Задач записано: ${taskRows.length}.`,
    priorNote.closed ? `Закрыто прежних задач: ${priorNote.closed}.` : '',
    priorNote.commented ? `Комментариев о просрочке: ${priorNote.commented}.` : '',
    createdMeetings ? `Новых встреч в календаре: ${createdMeetings}.` : '',
  ];
  return `${parts.filter(Boolean).join(' ')}${trackerNote}`;
}

// «Сделано» закрывает задачу прошлого протокола, «просрочено» оставляет комментарий. До утверждения Трекер не меняется.
async function applyPrior(db: Db, leaderId: string, row: { source: string; prior: unknown }): Promise<{ closed: number; commented: number }> {
  const meeting = meetingOfSource(row.source);
  const items = storedPrior(row.prior);
  if (!meeting || !items.length) return { closed: 0, commented: 0 };
  const previous = previousOf(await leaderProtocols(db, leaderId), meeting);
  if (!previous) return { closed: 0, commented: 0 };
  const effects = priorEffects(await protocolTasks(db, leaderId, previous.id), items, meeting.startsAt.slice(0, 10));
  let issues: { key: string; unique: string }[] = [];
  if (trackerConfig() && (effects.closeIds.length || effects.comments.length)) {
    try {
      issues = await listQueueIssues();
    } catch (err) {
      console.error('Трекер не отдал задачи', err instanceof Error ? err.message : err);
    }
  }
  const byUnique = new Map(issues.map((issue) => [issue.unique, issue]));
  let closed = 0;
  let commented = 0;
  for (const externalId of effects.closeIds) {
    await db.update(tasks).set({ status: 'закрыта' }).where(and(eq(tasks.leaderId, leaderId), eq(tasks.externalId, externalId)));
    const issue = byUnique.get(taskUnique(leaderId, externalId));
    if (!issue?.key) continue;
    try {
      if (await moveIssue(issue.key, 'close')) closed += 1;
    } catch (err) {
      console.error('Задача не закрыта', err instanceof Error ? err.message : err);
    }
  }
  for (const comment of effects.comments) {
    const issue = byUnique.get(taskUnique(leaderId, comment.externalId));
    if (!issue?.key) continue;
    try {
      await commentIssue(issue.key, comment.text);
      commented += 1;
    } catch (err) {
      console.error('Комментарий не записан', err instanceof Error ? err.message : err);
    }
  }
  return { closed, commented };
}

async function placeAgreed(leaderId: string, protocolId: string, meetings: AgreedMeeting[]): Promise<number> {
  const planned = scheduledMeetings(leaderId, protocolId, meetings);
  if (!planned.length || !calendarConfig()) return 0;
  let created = 0;
  try {
    const href = await ensureStandCalendar();
    for (const meeting of planned) {
      const description = [
        meeting.participants.length ? `Участники: ${meeting.participants.join(', ')}.` : '',
        'Встреча из протокола. Поставлена ИИ-помощником после утверждения.',
      ]
        .filter(Boolean)
        .join('\n');
      await putEvent(
        href,
        eventFile(meeting.uid),
        standEvent({ uid: meeting.uid, start: meetingStart(`${meeting.date}T${meeting.time}`), minutes: 30, summary: meeting.title, description }),
      );
      created += 1;
    }
  } catch (err) {
    console.error('Новая встреча не записана', err instanceof Error ? err.message : err);
  }
  return created;
}

export async function rejectProtocol(db: Db, id: string, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const [row] = await db.select().from(protocols).where(eq(protocols.id, id)).limit(1);
  if (!row || row.leaderId !== leader.id) return 'Протокол не найден';
  if (row.status === 'утверждён') return 'Уже утверждён';
  await db.update(protocols).set({ status: 'отклонён', awaitingEdit: false }).where(eq(protocols.id, id));
  return 'Протокол отклонён: задачи не созданы, письмо не ушло, в календарь не записан.';
}

export async function askProtocolEdit(db: Db, id: string, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const [row] = await db.select().from(protocols).where(eq(protocols.id, id)).limit(1);
  if (!row || row.leaderId !== leader.id) return 'Протокол не найден';
  if (row.status !== 'ждёт') return `Уже ${row.status}`;
  await db.update(protocols).set({ awaitingEdit: false }).where(eq(protocols.leaderId, leader.id));
  await db.update(protocols).set({ awaitingEdit: true }).where(eq(protocols.id, id));
  return 'Напишите, что поправить в протоколе. Правку помощник запомнит для следующих протоколов.';
}

// Текст правки: модель переписывает протокол по указанию руководителя, правка сохраняется для следующих протоколов (R6).
export async function saveProtocolEdit(db: Db, chatId: string, text: string): Promise<string | null> {
  const instead = text.trim();
  if (instead.length < 3) return null;
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return null;
  const [row] = await db
    .select()
    .from(protocols)
    .where(and(eq(protocols.leaderId, leader.id), eq(protocols.awaitingEdit, true)))
    .limit(1);
  if (!row) return null;
  const staff = await db.select({ name: people.name, position: people.position }).from(people).where(eq(people.leaderId, leader.id));
  const meeting = meetingOfSource(row.source);
  const earlier = previousOf(
    (await leaderProtocols(db, leader.id)).filter((item) => item.id !== row.id),
    meeting,
  );
  const priorTasks = earlier ? await protocolTasks(db, leader.id, earlier.id) : [];
  const result = await withLlmScope(
    { agent: 'protocol', leaderId: leader.id, operationId: `protocol-edit:${row.id}:${Date.now()}`, title: 'Правка протокола' },
    () =>
      callJson<unknown>({
        purpose: `protocol-edit:${leader.id}`,
        system: [
          'Ты правишь протокол встречи по указанию руководителя.',
          'Внеси правку и не меняй остальное.',
          'steps — отдельные поручения: одно поручение — один элемент, даже если их несколько у одного человека. owner — полное имя из списка людей или пустая строка. task — поручение без имени, не длиннее 120 знаков. due — дата ГГГГ-ММ-ДД или пустая строка.',
          'prior — статус каждой задачи прошлого протокола по её номеру: status строго «сделано», «не сделано», «просрочено» или «не обсуждали». Прошлых задач нет — prior пустой.',
          'meetings — встречи, о которых договорились: date ГГГГ-ММ-ДД или пусто, time ЧЧ:ММ или пусто. Не выдумывай время.',
          'Каждый пункт заметок, решений и открытых вопросов короче 250 знаков.',
        ].join(' '),
        user: [
          `Люди руководителя: ${staff.map((item) => `${item.name} (${item.position})`).join('; ')}.`,
          '',
          priorTasks.length ? `Задачи прошлого протокола:\n${numberedTasks(priorTasks)}` : 'Задач прошлого протокола нет.',
          '',
          'Протокол:',
          plainBody(row.body),
          '',
          `Правка руководителя: ${instead}`,
        ].join('\n'),
        schemaName: 'protocol',
        schema,
      }),
  );
  const parsed = draftZod.safeParse(result.data);
  if (!parsed.success) return 'Правку не удалось внести: ответ модели не прошёл проверку. Протокол прежний.';
  const draft = cleanDraft(parsed.data, staff, priorTasks);
  const body = renderProtocol(draft);
  await db
    .update(protocols)
    .set({ body, openItems: draft.open, steps: draft.steps, prior: draft.prior, agreed: draft.agreed, awaitingEdit: false })
    .where(eq(protocols.id, row.id));
  await db.insert(revisions).values({ id: randomUUID(), leaderId: leader.id, category: 'протокол', instead, createdAt: new Date() });
  await sendProtocol(body, chatId, row.id);
  return 'Протокол поправлен, новая версия выше. Правка записана: следующие протоколы её учтут.';
}

function cleanDraft(
  data: z.infer<typeof draftZod>,
  known: { name: string }[],
  priorTasks: { title: string; owner: string }[],
): ProtocolDraft {
  const steps = cleanSteps(data.steps, known);
  const prior = cleanPrior(data.prior, priorTasks.length);
  const agreed = cleanMeetings(data.meetings);
  const open = openWithMeetings(clip(data.open, 5), agreed);
  return {
    theme: data.theme.trim().slice(0, 180),
    participants: clip(data.participants, 12),
    previous: prior.flatMap((item) => {
      const task = priorTasks[item.n - 1];
      return task ? [priorLine(task, item)] : [];
    }),
    notes: clip(data.notes, 5),
    decisions: clip(data.decisions, 6),
    next: [],
    steps,
    proposals: clip(data.proposals, 3),
    open,
    prior,
    agreed,
  };
}

function numberedTasks(rows: { title: string; owner: string; dueOn: string; done: boolean }[]): string {
  return rows.map((task, index) => `${index + 1}. ${task.title} — ${task.owner}${task.dueOn ? `, срок ${task.dueOn}` : ''}, ${task.done ? 'закрыта' : 'открыта'}`).join('\n');
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
  // Контекст темы: прошлый протокол этой же серии встреч, задачи из него, письма участников за неделю, правки руководителя к протоколам.
  const prior = previousOf(await leaderProtocols(db, leaderId), meeting);
  const priorTasks = prior ? await protocolTasks(db, leaderId, prior.id) : [];
  const priorAt = prior ? meetingOfSource(prior.source) : null;
  const letters = await participantLetters(db, leaderId, meeting);
  const edits = (await db.select().from(revisions).where(and(eq(revisions.leaderId, leaderId), eq(revisions.category, 'протокол')))).map((row) => row.instead);
  const context = [
    prior && priorAt ? `Прошлый протокол этой темы (${whenWords(priorAt.startsAt)}, ${prior.status}):\n${plainBody(prior.body).slice(0, 2500)}` : 'Прошлого протокола этой темы нет.',
    priorTasks.length ? `Задачи прошлого протокола (номер нужен для статуса):\n${numberedTasks(priorTasks)}` : '',
    letters.length ? `Письма участников за неделю до встречи:\n${letters.map((row) => `— ${row.received.slice(0, 10)} ${row.from}: ${row.subject}. ${row.body}`).join('\n')}` : '',
    edits.length ? `Правки руководителя к прошлым протоколам — учитывай:\n${edits.slice(-8).map((item) => `— ${item}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const result = await withLlmScope(
    { agent: 'protocol', leaderId, operationId: `protocol:${leaderId}:${Date.now()}`, title: 'Протокол встречи' },
    () => callJson<unknown>({
    purpose: `protocol:${leaderId}`,
    system: [
      'Ты пишешь протокол встречи по расшифровке.',
      'Тема, участники, короткие заметки, решения, дальнейшие шаги, предложения помощника и открытые вопросы.',
      'Не выдумывай людей, решений и времени, которых нет в тексте. Пункт заметок, решений и открытых вопросов короче 250 знаков.',
      'Участников называй полным именем из списка людей руководителя.',
      'steps — отдельные поручения. Одно поручение — один элемент, даже если их несколько у одного человека: не объединяй. owner — полное имя из списка или пустая строка, если человека нет в списке. task — поручение без имени, не длиннее 120 знаков. due — дата ГГГГ-ММ-ДД или пустая строка. «сегодня» и «завтра» считай от дня встречи.',
      'prior — по каждой задаче прошлого протокола: n как в списке, status строго «сделано», «не сделано», «просрочено» или «не обсуждали», note — коротко, что выяснилось. Прошлых задач нет — prior пустой. Номера, которых нет в списке, не добавляй.',
      'meetings — новые встречи, о которых договорились на этой встрече, не сама эта серия. date — ГГГГ-ММ-ДД или пусто, time — ЧЧ:ММ или пусто, participants — полные имена. Нет даты или времени — оставь пустым, не выдумывай.',
    ].join(' '),
    user: [
      meeting ? `Встреча: ${meeting.title}, ${meeting.startsAt.replace('T', ' ')} по Москве.` : '',
      `Люди руководителя: ${staff.map((row) => `${row.name} (${row.position})`).join('; ')}.`,
      '',
      context,
      '',
      'Расшифровка встречи:',
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
  const draft = cleanDraft(parsed.data, staff, priorTasks);
  const id = randomUUID().replace(/-/g, '').slice(0, 8);
  const body = renderProtocol(draft);
  await db.insert(protocols).values({
    id,
    leaderId,
    source: source.name,
    body,
    openItems: draft.open,
    steps: draft.steps,
    prior: draft.prior,
    agreed: draft.agreed,
    status: 'ждёт',
    transcriptAt: arrived,
    createdAt: new Date(),
  });
  await sendProtocol(body, leader.telegramChatId, id);
  const sentAt = new Date();
  await db.update(protocols).set({ sentAt }).where(eq(protocols.id, id));
  return { id };
}
