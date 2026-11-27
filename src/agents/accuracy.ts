// Точность разбора почты по эталону expected_action. Эталон в запрос модели не входит.
// Письмо категорий N1 код переводит в «спросить» и никуда не отправляет.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { emailEtalon, emails, leaders, mailActions } from '../db/schema.ts';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';
import { confirmationPoints, leaderMustConfirm } from './confirm.ts';
import { chainKey } from './k2.ts';

export const MAIL_ACTIONS = ['спросить_руководителя', 'делегировать', 'в_сводку', 'игнорировать', 'авто'] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];

function accuracyContract(points: string[]) {
  const choices = [...points, 'иное'] as unknown as [string, ...string[]];
  const zod = z.object({ действие: z.enum(MAIL_ACTIONS), категория: z.enum(choices) });
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['действие', 'категория'],
    properties: {
      действие: { type: 'string', enum: [...MAIL_ACTIONS] },
      категория: { type: 'string', enum: choices },
    },
  };
  return { zod, schema };
}

const SYSTEM = [
  'Ты разбираешь одно письмо по правилам профиля руководителя.',
  'Выбери действие и категорию.',
  'Категория — дословно пункт раздела «Никогда без подтверждения руководителя», если письмо про этот пункт, иначе «иное».',
  'спросить_руководителя — письмо относится к такому пункту, просьба выше полномочий отправителя или решение только его уровня.',
  'делегировать — это в зоне исполнителя, ответ возвращает ему ответственность.',
  'в_сводку — отчёт или статус, ответа не нужно.',
  'игнорировать — рассылка или письмо не ему.',
  'авто — по уже записанному правилу профиля помощник делает это сам.',
  'Эталонных меток у тебя нет.',
].join(' ');

export function forceMailAction(category: string, points: string[], chosen: MailAction): { action: MailAction; forced: boolean } {
  if (leaderMustConfirm(category, points) && chosen !== 'спросить_руководителя') return { action: 'спросить_руководителя', forced: true };
  return { action: chosen, forced: false };
}

export function mailScore(rows: { expected: string; action: string }[]): {
  total: number;
  hit: number;
  misses: { pair: string; count: number }[];
} {
  const buckets = new Map<string, number>();
  let hit = 0;
  for (const row of rows) {
    if (row.expected === row.action) {
      hit += 1;
      continue;
    }
    const pair = `${row.expected} → ${row.action}`;
    buckets.set(pair, (buckets.get(pair) ?? 0) + 1);
  }
  return {
    total: rows.length,
    hit,
    misses: [...buckets.entries()].map(([pair, count]) => ({ pair, count })).sort((a, b) => b.count - a.count),
  };
}

export async function judgeMail(input: { purpose: string; profile: string; letter: string }): Promise<{ action: MailAction; category: string }> {
  const points = confirmationPoints(input.profile);
  const { zod, schema } = accuracyContract(points);
  const result = await callJson<unknown>({
    purpose: input.purpose,
    system: SYSTEM,
    user: ['Профиль:', input.profile.trim(), '', 'Письмо:', input.letter.trim()].join('\n'),
    schemaName: 'mail_action',
    schema,
  });
  const parsed = zod.safeParse(result.data);
  if (!parsed.success) throw new Error('Ответ модели не совпал со схемой действия');
  return { action: parsed.data.действие, category: parsed.data.категория };
}

export async function accuracyView(db: Db, leaderId: string) {
  const [stored, letterRows, etalonRows] = await Promise.all([
    db.select().from(mailActions).where(eq(mailActions.leaderId, leaderId)),
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
    db.select().from(emailEtalon).where(eq(emailEtalon.leaderId, leaderId)),
  ]);
  if (stored.length === 0) return null;
  const byKey = new Map(stored.map((row) => [row.chainKey, row.action]));
  const expected = new Map(etalonRows.map((row) => [row.externalId, row.expectedAction]));
  const scored = letterRows.flatMap((letter) => {
    const goal = expected.get(letter.externalId);
    const action = byKey.get(chainKey(letter.fromEmail, letter.subject));
    if (!goal || !action) return [];
    return [{ expected: goal, action }];
  });
  return { ...mailScore(scored), calls: stored.length, forced: stored.filter((row) => row.forced).length };
}

export async function measureAccuracy(db: Db, leaderId: string): Promise<{ calls: number }> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader) throw new Error('Руководитель не найден');
  const [letterRows, etalonRows, stored] = await Promise.all([
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
    db.select().from(emailEtalon).where(eq(emailEtalon.leaderId, leaderId)),
    db.select().from(mailActions).where(eq(mailActions.leaderId, leaderId)),
  ]);
  const known = new Set(etalonRows.map((row) => row.externalId));
  const done = new Set(stored.map((row) => row.chainKey));
  const threads = new Map<string, { letter: string }>();
  for (const letter of letterRows) {
    if (!known.has(letter.externalId)) continue;
    const key = chainKey(letter.fromEmail, letter.subject);
    if (done.has(key) || threads.has(key)) continue;
    threads.set(key, {
      letter: `От: ${letter.fromName}\nТема: ${letter.subject}\n${letter.body}`,
    });
  }
  const points = confirmationPoints(leader.profile);
  let calls = 0;
  for (const [key, thread] of threads) {
    const chosen = await withLlmScope(
      { agent: 'accuracy', leaderId, operationId: crypto.randomUUID(), title: 'Разбор письма для точности' },
      () => judgeMail({ purpose: `accuracy:${leaderId}`, profile: leader.profile, letter: thread.letter }),
    );
    const ruled = forceMailAction(chosen.category, points, chosen.action);
    await db.insert(mailActions).values({
      leaderId,
      chainKey: key,
      action: ruled.action,
      forced: ruled.forced,
      createdAt: new Date(),
    });
    calls += 1;
  }
  return { calls };
}
