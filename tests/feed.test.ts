import { describe, expect, it } from 'vitest';
import { assembleFeed, prepareFeed, reminderLabel, type FeedDecision, type FeedInput, type FeedLetter, type FeedSource, type FeedVerdict } from '../src/agents/feed.ts';
import { hideMailbox } from '../src/agents/intake.ts';

function verdict(over: Partial<FeedVerdict> & Pick<FeedVerdict, 'id' | 'leaderId' | 'kind'>): FeedVerdict {
  return {
    messageId: over.id,
    chainKey: over.id,
    category: 'иное',
    summary: 'суть',
    basis: 'основание',
    createdAt: '2026-12-01T08:00:00.000Z',
    ...over,
  };
}

function letter(over: Partial<FeedLetter> & Pick<FeedLetter, 'leaderId' | 'messageId'>): FeedLetter {
  return { syntheticId: '', received: '2026-12-02T09:00:00.000Z', fromName: 'Кира', subject: 'Срок отчёта', ...over };
}

function decision(over: Partial<FeedDecision> & Pick<FeedDecision, 'id' | 'leaderId'>): FeedDecision {
  return { status: 'исполнено', replyName: 'Кира', draft: 'Ответ отправлен', ...over };
}

function source(over: Partial<FeedSource> = {}): FeedSource {
  return { verdicts: [], inbox: [], catalog: [], decisions: [], ...over };
}

function row(over: Partial<FeedInput> & Pick<FeedInput, 'id' | 'kind' | 'chainKey' | 'at'>): FeedInput {
  return { category: 'иное', summary: 'суть', basis: 'основание', fromName: 'Кира', subject: 'Срок', sentTo: '', sentText: '', ...over };
}

describe('журнал разбора почты', () => {
  it('повторы одной переписки сворачиваются к основному разбору', () => {
    const page = assembleFeed([
      row({ id: 'v-1', kind: 'вернуть', chainKey: 'тема', at: '2026-12-01', sentTo: 'Кира', sentText: 'Готово' }),
      row({ id: 'v-2', kind: 'повтор', chainKey: 'тема', at: '2026-12-03' }),
      row({ id: 'v-3', kind: 'повтор', chainKey: 'тема', at: '2026-12-02' }),
      row({ id: 'v-4', kind: 'нужен_руководитель', chainKey: 'другая', at: '2026-12-04' }),
    ]);
    expect(page.items.map((item) => item.id)).toEqual(['v-4', 'v-1']);
    const main = page.items.find((item) => item.id === 'v-1');
    expect(main?.reminders.map((item) => item.at)).toEqual(['2026-12-03', '2026-12-02']);
    expect(reminderLabel(main?.reminders.length ?? 0)).toBe('ещё 2 напоминания');
    expect(page.items.some((item) => item.kind === 'повтор')).toBe(false);
  });

  it('числа фильтра считаются по всем разборам, не по странице', () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      row({
        id: `v-${index}`,
        kind: index % 2 === 0 ? 'вернуть' : 'нужен_руководитель',
        chainKey: `c-${index}`,
        at: `2026-12-${String((index % 28) + 1).padStart(2, '0')}T0${index % 10}:00:00.000Z`,
      }),
    );
    rows.push(row({ id: 'rep', kind: 'повтор', chainKey: 'c-0', at: '2026-12-20T12:00:00.000Z' }));
    const first = assembleFeed(rows, { offset: 0, limit: 20 });
    expect(first.items).toHaveLength(20);
    expect(first.more).toBe(true);
    expect(first.counts.find((item) => item.kind === 'вернуть')?.n).toBe(13);
    expect(first.counts.find((item) => item.kind === 'нужен_руководитель')?.n).toBe(12);
    expect(first.counts.find((item) => item.kind === 'повтор')?.n).toBe(1);
    const filtered = assembleFeed(rows, { offset: 0, limit: 20, kind: 'вернуть' });
    expect(filtered.items.every((item) => item.kind === 'вернуть')).toBe(true);
    expect(filtered.counts.find((item) => item.kind === 'нужен_руководитель')?.n).toBe(12);
  });

  it('у ответа и пересылки видны получатель и текст, у остальных нет', () => {
    const hide = (text: string) => hideMailbox(text, 'box@example.com');
    const rows = prepareFeed(
      'a',
      source({
        verdicts: [
          verdict({ id: 'v-1', leaderId: 'a', kind: 'вернуть', messageId: 'm1', summary: 'Ответ box@example.com' }),
          verdict({ id: 'v-2', leaderId: 'a', kind: 'делегировать', messageId: 'm2' }),
          verdict({ id: 'v-3', leaderId: 'a', kind: 'нужен_руководитель', messageId: 'm3' }),
          verdict({ id: 'v-4', leaderId: 'a', kind: 'вернуть', messageId: 'm4' }),
        ],
        inbox: [
          letter({ leaderId: 'a', messageId: 'm1', syntheticId: '1', fromName: 'Кира', subject: 'Срок' }),
          letter({ leaderId: 'a', messageId: 'm2', syntheticId: '2', fromName: 'Инга', subject: 'Закупка' }),
          letter({ leaderId: 'a', messageId: 'm3', syntheticId: '3', fromName: 'Глеб', subject: 'Бюджет' }),
        ],
        catalog: [{ leaderId: 'a', externalId: '4', received: '2026-12-05', fromName: 'Нина', subject: 'Отпуск' }],
        decisions: [
          decision({ id: '1', leaderId: 'a', replyName: 'Кира', draft: 'Текст ответа box@example.com' }),
          decision({ id: '2', leaderId: 'a', replyName: 'Инга', draft: 'Пересылаю вам' }),
          decision({ id: '3', leaderId: 'a', replyName: 'Глеб', draft: 'Черновик руководителю' }),
          decision({ id: '4', leaderId: 'a', status: 'ждёт', replyName: 'Нина', draft: 'Ещё не ушло' }),
        ],
      }),
      hide,
    );
    const reply = rows.find((item) => item.id === 'v-1');
    const forward = rows.find((item) => item.id === 'v-2');
    const held = rows.find((item) => item.id === 'v-3');
    const waiting = rows.find((item) => item.id === 'v-4');
    expect(reply?.fromName).toBe('Кира');
    expect(reply?.subject).toBe('Срок');
    expect(reply?.at).toBe('2026-12-02T09:00:00.000Z');
    expect(reply?.sentTo).toBe('Кира');
    expect(reply?.sentText).toBe('Текст ответа');
    expect(reply?.summary).not.toContain('box@example.com');
    expect(forward?.sentTo).toBe('Инга');
    expect(forward?.sentText).toBe('Пересылаю вам');
    expect(held?.sentTo).toBe('');
    expect(held?.sentText).toBe('');
    expect(waiting?.sentText).toBe('');
    expect(waiting?.fromName).toBe('Нина');
  });

  it('показать ещё отдаёт следующую порцию без повторов', () => {
    const rows = Array.from({ length: 22 }, (_, index) =>
      row({ id: `v-${index}`, kind: 'в_сводку', chainKey: `c-${index}`, at: `2026-11-${String((index % 28) + 1).padStart(2, '0')}` }),
    );
    rows.push(row({ id: 'again', kind: 'повтор', chainKey: 'c-21', at: '2026-11-28' }));
    const first = assembleFeed(rows, { offset: 0, limit: 20 });
    const second = assembleFeed(rows, { offset: first.items.length, limit: 20 });
    expect(first.more).toBe(true);
    expect(second.more).toBe(false);
    expect(second.items.length).toBeGreaterThan(0);
    const seen = new Set(first.items.map((item) => item.id));
    for (const item of second.items) expect(seen.has(item.id)).toBe(false);
    expect([...first.items, ...second.items].some((item) => item.id === 'again')).toBe(false);
    expect(first.items.find((item) => item.id === 'v-21')?.reminders).toHaveLength(1);
  });

  it('второй руководитель видит только свои разборы', () => {
    const rows = prepareFeed(
      'b',
      source({
        verdicts: [
          verdict({ id: 'v-a', leaderId: 'a', kind: 'вернуть', messageId: 'ma' }),
          verdict({ id: 'v-b', leaderId: 'b', kind: 'делегировать', messageId: 'mb' }),
        ],
        inbox: [
          letter({ leaderId: 'a', messageId: 'ma', fromName: 'Кира', subject: 'Чужое' }),
          letter({ leaderId: 'b', messageId: 'mb', fromName: 'Инга', subject: 'Своё' }),
        ],
        decisions: [
          decision({ id: 'a', leaderId: 'a', replyName: 'Кира', draft: 'Чужой ответ' }),
          decision({ id: 'b', leaderId: 'b', replyName: 'Инга', draft: 'Свой ответ' }),
        ],
      }),
      (text) => text,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('v-b');
    expect(rows[0]?.fromName).toBe('Инга');
    expect(rows[0]?.subject).toBe('Своё');
    expect(rows[0]?.sentTo).toBe('Инга');
    expect(rows[0]?.sentText).toBe('Свой ответ');
  });
});
