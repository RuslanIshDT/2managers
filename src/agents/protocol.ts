// Протокол по расшифровке. Текст встречи в репозиторий не входит: его читает стенд с диска.
// Утверждение — кнопка в Telegram. Рассылка участникам здесь не делается.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { leaders, protocols } from '../db/schema.ts';
import { callJson, type JsonSchema } from '../llm.ts';
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
  lines.push('', 'Рассылка участникам — заглушка, письма не уходят.');
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
  return { status: row.status, open: row.open.length };
}

export async function latestProtocol(db: Db, leaderId: string) {
  const rows = await db.select().from(protocols).where(eq(protocols.leaderId, leaderId)).orderBy(desc(protocols.createdAt)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const open = Array.isArray(row.openItems) ? row.openItems.filter((item): item is string => typeof item === 'string') : [];
  return { id: row.id, source: row.source, body: row.body, open, status: row.status };
}

export function morningOpenItems(open: string[]): string {
  if (!open.length) return '';
  return ['', 'Открытые вопросы прошлого протокола:', ...open.map((item) => `— ${esc(item)}`)].join('\n');
}

export async function approveProtocol(db: Db, id: string, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const [row] = await db
    .select()
    .from(protocols)
    .where(eq(protocols.id, id))
    .limit(1);
  if (!row || row.leaderId !== leader.id) return 'Протокол не найден';
  if (row.status === 'утверждён') return 'Уже утверждён';
  await db.update(protocols).set({ status: 'утверждён' }).where(eq(protocols.id, id));
  return 'Протокол утверждён. Рассылка — заглушка, письма не ушли.';
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
  const result = await callJson<unknown>({
    purpose: `protocol:${leaderId}`,
    system: [
      'Ты пишешь протокол встречи по расшифровке.',
      'Тема, участники, короткие заметки, решения, дальнейшие шаги, предложения помощника и открытые вопросы.',
      'Не выдумывай людей и решений, которых нет в тексте. Каждый пункт короче 250 знаков.',
    ].join(' '),
    user: source.text,
    schemaName: 'protocol',
    schema,
  });
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
    createdAt: new Date(),
  });
  await sendMessage(body, leader.telegramChatId, {
    reply_markup: { inline_keyboard: [[{ text: 'Утвердить', callback_data: protocolCallback(id) }]] },
  });
  return { id };
}
