// Карточка решения: что показать руководителю и что делают отказ и откладывание.
// Имена и даты приходят из данных, в коде их нет.
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { decisions } from '../db/schema.ts';
import { clockFor } from './scene.ts';

export function letterExcerpt(body: string): { excerpt: string; collapsed: boolean } {
  const text = body.replace(/\s+$/u, '').replace(/^\s+/u, '');
  if (!text) return { excerpt: '', collapsed: false };
  const lines = text.split('\n');
  const head = lines.slice(0, 3).join('\n');
  if (lines.length <= 3 && head.length <= 320) return { excerpt: head, collapsed: false };
  const cut = head.length > 320 ? `${head.slice(0, 320).trimEnd()}…` : head;
  return { excerpt: cut, collapsed: true };
}

export function refusalLetter(reason: string): string {
  const why = reason.trim();
  const lines = ['Здравствуйте.', '', 'Эту просьбу согласовать не могу.'];
  if (why) lines.push('', `Причина: ${why}`);
  return lines.join('\n');
}

export function refusalResult(reason: string): string {
  const why = reason.trim();
  return why ? `Отказано, письмо отправителю. Причина: ${why}` : 'Отказано, письмо отправителю';
}

export interface RefusalPorts {
  send(name: string, email: string, subject: string, body: string): Promise<void>;
  save(status: string): Promise<void>;
  journal(row: { action: string; result: string; approved: string }): Promise<void>;
}

export async function performRefusal(
  decision: { replyName: string; replyTo: string; subject: string },
  reason: string,
  ports: RefusalPorts,
): Promise<string> {
  if (!decision.replyTo.trim()) return 'Нет адреса отправителя, письмо не отправлено';
  const letter = refusalLetter(reason);
  await ports.send(decision.replyName, decision.replyTo, decision.subject, letter);
  await ports.save('отклонено');
  await ports.journal({ action: 'отклонил', result: refusalResult(reason), approved: letter });
  return 'Отправителю отправлен отказ';
}

export function deferIsDue(until: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  return until <= today;
}

export function reviveDeferred<T extends { status: string; deferUntil: string }>(rows: T[], today: string): T[] {
  return rows.map((row) =>
    row.status === 'отложено' && deferIsDue(row.deferUntil, today) ? { ...row, status: 'ждёт', deferUntil: '' } : row,
  );
}

export function parseDeferDate(text: string, today: string): string | null {
  const raw = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return calendarDay(iso[1], iso[2], iso[3]);
  const full = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (full) return calendarDay(full[3], full[2].padStart(2, '0'), full[1].padStart(2, '0'));
  const short = /^(\d{1,2})\.(\d{1,2})$/.exec(raw);
  const year = today.slice(0, 4);
  if (short && /^\d{4}$/.test(year)) return calendarDay(year, short[2].padStart(2, '0'), short[1].padStart(2, '0'));
  return null;
}

function calendarDay(year: string, month: string, day: string): string | null {
  const iso = `${year}-${month}-${day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export async function releaseDeferred(db: Db, leaderId: string, today = clockFor(leaderId).today): Promise<void> {
  const rows = await db
    .select({ id: decisions.id, status: decisions.status, deferUntil: decisions.deferUntil })
    .from(decisions)
    .where(and(eq(decisions.leaderId, leaderId), eq(decisions.status, 'отложено')));
  for (const row of reviveDeferred(rows, today)) {
    if (row.status !== 'ждёт') continue;
    await db.update(decisions).set({ status: 'ждёт', deferUntil: '' }).where(and(eq(decisions.id, row.id), eq(decisions.leaderId, leaderId)));
  }
}

export function sendLabel(name: string): string {
  const who = name.trim();
  const label = who ? `Отправить ответ ${who}` : 'Отправить ответ';
  return [...label].slice(0, 64).join('');
}
