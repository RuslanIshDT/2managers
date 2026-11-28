import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { agentBaseName, helperIdForName } from '../src/agents/agent-names.ts';
import { buildDesk, type DeskInput } from '../src/agents/desk.ts';

function desk(over: Partial<DeskInput> = {}) {
  const input: DeskInput = {
    accepted: true,
    decisions: [],
    verdicts: [],
    letters: [],
    meetings: [],
    rules: [],
    people: [],
    authorities: [],
    history: [],
    series: [],
    relief: null,
    tasks: [],
    calls: [],
    ...over,
  };
  return buildDesk(input);
}

function guideNames(text: string): string[] {
  return [...text.matchAll(/^- агент: \*\*(.+?)\*\*/gm)].map((match) => match[1] ?? '');
}

describe('один перечень агентов', () => {
  it('имя из документации есть у карточки, и наоборот', async () => {
    const text = await readFile('docs/guide.md', 'utf8');
    const names = guideNames(text);
    const cards = desk().helpers;
    const cardNames = new Set(cards.map((card) => card.name));
    for (const name of names) {
      const base = agentBaseName(name);
      expect(cardNames.has(name) || cardNames.has(base), name).toBe(true);
      expect(helperIdForName(name, cards), name).toBeTruthy();
    }
    const bases = new Set(names.map(agentBaseName));
    for (const card of cards) {
      expect(bases.has(card.name), card.name).toBe(true);
      expect(card.does.split('.').filter((part) => part.trim()).length).toBe(1);
    }
  });

  it('заглушка помечена, когда Трекера и календаря нет', () => {
    const cards = desk().helpers;
    expect(cards.find((card) => card.name === 'Список задач')?.mode).toBe('заглушка');
    expect(cards.find((card) => card.name === 'Календарь')?.mode).toBe('заглушка');
    const live = desk({ remote: { tracker: true, calendar: true } }).helpers;
    expect(live.find((card) => card.name === 'Список задач')?.mode).toBe('код');
    expect(live.find((card) => card.name === 'Календарь')?.mode).toBe('код');
  });

  it('числа за неделю берутся из вызовов и журнала, пустое так и сказано', () => {
    const empty = desk().helpers;
    expect(empty.find((card) => card.name === 'Разбор почты')?.did).toContain('нет');
    expect(empty.find((card) => card.name === 'Сверка черновика')?.did).toContain('нет');
    expect(empty.find((card) => card.name === 'Память руководителя')?.did).toContain('нет');
    const filled = desk({
      calls: [
        { purpose: 'k2:a', at: '2026-12-01T08:00:00.000Z', agent: 'k2' },
        { purpose: 'k2:b', at: '2026-12-02T08:00:00.000Z', agent: 'k2' },
        { purpose: 'mail_ext:c', at: '2026-12-03T08:00:00.000Z', agent: 'mail_ext' },
        { purpose: 'draft-check', at: '2026-12-03T09:00:00.000Z', agent: 'draft-check' },
        { purpose: 'right', at: '2026-12-03T10:00:00.000Z', agent: 'right' },
      ],
      facts: { revisions: 2, protocols: 1, reminders: 0, notes: 0, seriesKinds: 3, acts: 4, tasks: 0, goals: 0 },
      decisions: [{ id: 'd', status: 'ждёт', summary: 'Тема', replyName: 'Глеб', createdAt: '2026-12-01', category: '', draftNote: 'не сверено' }],
    }).helpers;
    const mail = filled.find((card) => card.name === 'Разбор почты');
    expect(mail?.did).toContain('2 вызова');
    expect(mail?.did).toContain('1 вызов');
    expect(mail?.did).not.toContain('извне: вызовов нет');
    expect(filled.find((card) => card.name === 'Сверка черновика')?.did).toContain('1 вызов');
    expect(filled.find((card) => card.name === 'Сверка черновика')?.result).toContain('1');
    expect(filled.find((card) => card.name === 'Память руководителя')?.did).toContain('2');
    expect(filled.find((card) => card.name === 'Сроки')?.did).toContain('нет');
    expect(helperIdForName('Разбор почты (внутр.)', filled)).toBe('k2');
    expect(helperIdForName('Разбор почты (внеш.)', filled)).toBe('k2');
    expect(helperIdForName('Принятое право', filled)).toBe('k12');
  });
});
