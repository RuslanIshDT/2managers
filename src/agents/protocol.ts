// Протокол по расшифровке. Текст встречи в репозиторий не входит: его читает стенд с диска.
// После «Утвердить» протокол уходит в тестовый ящик, задачи пишутся в базу, встреча — файлом .ics.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { leaders, people, protocols, tasks } from '../db/schema.ts';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';
import { mailConfig, sendMail } from '../mail.ts';
import { sendMessage } from '../telegram.ts';

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
  return lines.join('\n').slice(0, 3500);
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

export function protocolRelease(body: string, known: { name: string; email: string }[], at: Date, id = 'protocol'): ProtocolRelease {
  const theme = body.split('\n')[0]?.trim() || 'Встреча по протоколу';
  const participants = participantNames(body);
  const steps = sectionLines(body, 'Дальше:').map((line) => line.replace(/^—\s*/, '').trim()).filter(Boolean);
  const when = followUpStart(at);
  const dueOn = moscowDate(when);
  const tasks = steps.map((title) => ({ title: title.slice(0, 240), owner: ownerOf(title, participants), dueOn }));
  const named = participants.map((name) => {
    const person = known.find((row) => row.name.toLowerCase() === name.toLowerCase() && row.email.trim());
    return person ? `${name} <${person.email}>` : name;
  });
  const text = [
    named.length ? `Кому: ${named.join('; ')}.` : 'Кому: участники в протоколе не названы.',
    'Адреса из каталога писем не принимают, поэтому письмо ушло в тестовый ящик. Настоящие адресаты названы выше.',
    'Календарь не подключён: приглашение на встречу во вложении.',
    '',
    body.replace(/\nРассылка участникам — заглушка, письма не уходят\./g, '').trim(),
    '',
    `Встреча: ${theme}. ${dueOn}, 10:00 по Москве, 30 минут.`,
  ].join('\n');
  return {
    subject: `Протокол: ${theme}`.slice(0, 180),
    text,
    tasks,
    ics: invitation({ uid: `protocol-${id}`, start: when, summary: theme, description: steps.join('\n') }),
    when,
  };
}

export async function approveProtocol(db: Db, id: string, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const [row] = await db.select().from(protocols).where(eq(protocols.id, id)).limit(1);
  if (!row || row.leaderId !== leader.id) return 'Протокол не найден';
  if (row.status === 'утверждён') return 'Уже утверждён';
  const mailbox = mailConfig();
  if (!mailbox) return 'Яндекс Почта не настроена';
  const known = await db.select({ name: people.name, email: people.email }).from(people).where(eq(people.leaderId, leader.id));
  const release = protocolRelease(row.body, known, row.createdAt, row.id);
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
  await sendMail(mailbox.user, release.subject, release.text, [
    { filename: 'vstrecha.ics', content: release.ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' },
  ]);
  await db.update(protocols).set({ status: 'утверждён' }).where(eq(protocols.id, row.id));
  const count = release.tasks.length;
  return `Протокол утверждён. Письмо с приглашением ушло в тестовый ящик, задач записано: ${count}.`;
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

function ownerOf(title: string, participants: string[]): string {
  const found = participants.filter((name) => title.toLowerCase().includes(name.toLowerCase()));
  found.sort((a, b) => b.length - a.length);
  return found[0] ?? 'не назван';
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

function invitation(input: { uid: string; start: Date; summary: string; description: string }): string {
  const end = new Date(input.start.getTime() + 30 * 60 * 1000);
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
}

async function smallestTranscript(dir: string): Promise<{ name: string; text: string }> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('-transcript.txt'));
  if (!names.length) throw new Error('Расшифровок нет');
  const sized = await Promise.all(names.map(async (name) => ({ name, size: (await stat(join(dir, name))).size })));
  sized.sort((a, b) => a.size - b.size);
  const picked = sized[0];
  if (!picked) throw new Error('Расшифровок нет');
  const text = await readFile(join(dir, picked.name), 'utf8');
  return { name: picked.name, text: text.slice(0, MAX_TRANSCRIPT) };
}

export async function writeProtocol(db: Db, leaderId: string, dir = process.env.MEETINGS_DIR || '/app/meetings'): Promise<{ id: string }> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader?.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
  const source = await smallestTranscript(dir);
  const arrived = (await stat(join(dir, source.name))).mtime;
  const result = await withLlmScope(
    { agent: 'protocol', leaderId, operationId: `protocol:${leaderId}:${Date.now()}`, title: 'Протокол встречи' },
    () => callJson<unknown>({
    purpose: `protocol:${leaderId}`,
    system: [
      'Ты пишешь протокол встречи по расшифровке.',
      'Тема, участники, короткие заметки, решения, дальнейшие шаги, предложения помощника и открытые вопросы.',
      'Не выдумывай людей и решений, которых нет в тексте. Каждый пункт короче 250 знаков.',
    ].join(' '),
    user: source.text,
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
    notes: clip(parsed.data.notes, 6),
    decisions: clip(parsed.data.decisions, 6),
    next: clip(parsed.data.next, 6),
    proposals: clip(parsed.data.proposals, 4),
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
