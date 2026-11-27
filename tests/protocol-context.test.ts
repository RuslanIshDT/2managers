import { describe, expect, it } from 'vitest';
import { bodySection, meetingOfFile, plainBody, previousOf, questionsOf, whenWords } from '../src/agents/protocol-context.ts';
import { foldIcsLine } from '../src/agents/materials.ts';
import { messageParts } from '../src/agents/protocol.ts';

// Протоколы придуманы для теста, в синтетике их нет.
const body = [
  'Сменная планёрка цеха',
  '',
  'Участники: Пётр Сидоров, Вера Петрова.',
  '',
  'Решения:',
  '— Запускаем вторую линию с понедельника',
  '',
  'Дальше:',
  '— Пётр Сидоров: проверить оснастку до 14 декабря',
  '— Вера Петрова: график смен до 12 декабря',
  '',
  'Открытые вопросы:',
  '— Кто закрывает ночную смену &amp; выходные',
].join('\n');

const row = (id: string, source: string, status = 'утверждён') => ({ id, source, body, status, open: ['Кто закрывает ночную смену &amp; выходные'] });

describe('контекст темы встреч', () => {
  it('прошлый протокол — последний той же темы до этой встречи', () => {
    const rows = [
      row('a1', '2026-12-07T09-00 Сменная планёрка-transcript.txt'),
      row('a2', '2026-12-08T09-00 Сменная планёрка-transcript.txt'),
      row('b1', '2026-12-08T11-00 Закупки-transcript.txt'),
      row('a3', '2026-12-10T09-00 Сменная планёрка-transcript.txt'),
    ];
    expect(meetingOfFile(rows[0].source)).toEqual({ title: 'Сменная планёрка', startsAt: '2026-12-07T09:00' });
    expect(previousOf(rows, { title: 'Сменная планёрка', startsAt: '2026-12-09T09:00' })?.id).toBe('a2');
    expect(previousOf(rows, { title: 'Закупки', startsAt: '2026-12-08T11:00' })).toBeNull();
    expect(whenWords('2026-12-09T09:00')).toBe('9 декабря, 09:00');
  });

  it('вопросы по прошлому протоколу: открытые вопросы и незакрытые задачи', () => {
    expect(bodySection(body, 'Дальше:')).toEqual(['Пётр Сидоров: проверить оснастку до 14 декабря', 'Вера Петрова: график смен до 12 декабря']);
    const approved = questionsOf(row('a1', 'x'), [
      { title: 'Пётр Сидоров: проверить оснастку до 14 декабря', done: false },
      { title: 'Вера Петрова: график смен до 12 декабря', done: true },
    ]);
    expect(approved).toEqual(['Кто закрывает ночную смену & выходные', 'Пётр Сидоров: проверить оснастку до 14 декабря — задача открыта']);
    // Неутверждённый протокол: задач ещё нет — только открытые вопросы.
    expect(questionsOf(row('a1', 'x', 'ждёт'), [])).toEqual(['Кто закрывает ночную смену & выходные']);
    expect(plainBody('a &lt;b&gt; &amp; c')).toBe('a <b> & c');
  });

  it('длинное описание события складывается по 75 байт и не режет буквы', () => {
    const line = `DESCRIPTION:${'Протокол встречи '.repeat(20)}`;
    const folded = foldIcsLine(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('длинный протокол уходит в Telegram частями по строкам, ничего не теряется', () => {
    const text = Array.from({ length: 120 }, (_, i) => `— пункт ${i} ${'текст '.repeat(8)}`).join('\n');
    const parts = messageParts(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1000);
    expect(parts.join('\n')).toBe(text);
  });
});
