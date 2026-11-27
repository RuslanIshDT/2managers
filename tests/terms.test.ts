import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { limitBreaches } from '../src/agents/confirm.ts';
import { latestDecision } from '../src/agents/intake.ts';
import { chainKey, enforce, type ModelVerdict } from '../src/agents/k2.ts';
import { changeWords, letterTerms, termChanges } from '../src/agents/terms.ts';

const model: ModelVerdict = {
  действие: 'ответить',
  кому_передать: '',
  в_полномочиях: 'да',
  есть_предложение: 'да',
  только_руководитель: 'нет',
  категория: 'иное',
  суть: 'Просьба по договору',
  контекст: '',
  рекомендация: 'Согласовать',
  черновик_ответа: 'Решите сами по своему праву.',
  предложение_полномочия: '',
  основание: 'В полномочиях',
  риски: '',
  если_не_решить: '',
  уверенность: 0.8,
};

// Письма придуманы для теста, в синтетике их нет: проверка на новом письме (AGENTS.md).
const first = 'Условия для «Северный ветер»\nКлиент просит 7% на поставку 2,5 млн ₽, ответить до среды. Предлагаю согласиться.';
const same = 'Условия для «Северный ветер»\nКлиент просит 7% на поставку 2,5 млн ₽, ответить до среды. Предлагаю согласиться.';
const higher = 'Re: Условия для «Северный ветер»\nКлиент передумал: просит 11% и поставку 3 млн ₽. Предлагаю согласиться.';
const later = 'Re: Условия для «Северный ветер»\nКлиент просит перенести поставку на 22 января. Предлагаю согласиться.';
const promise = 'Re: Условия для «Северный ветер»\nЯ уже пообещал клиенту бесплатное обучение. Предлагаю так и оставить.';

describe('T56: изменение условий в продолжающейся переписке', () => {
  it('находит в письме процент, сумму, срок и обязательство', () => {
    const terms = letterTerms('Скидка 12% на контракт 4,8 млн ₽ до 25 декабря, ответ до четверга, 18.12. Гарантируем запуск.');
    expect(terms.процент).toEqual(['12%']);
    expect(terms.сумма).toEqual(['4,8 млн ₽']);
    expect(terms.срок).toEqual(expect.arrayContaining(['25 декабря', '18.12', 'четверг']));
    expect(terms.обязательство).toEqual(['гарантия']);
    expect(letterTerms('Версия 4.8 и 300 пользователей').срок).toEqual([]);
    expect(letterTerms('Прошу 4 часа сверхурочных на 2 смены').количество).toEqual(['4 часа', '2 смены']);
    expect(termChanges(['Прошу 4 часа сверхурочных'], 'Re: прошу 4 часов, как договорились')).toEqual([]);
    expect(changeWords(termChanges(['Прошу 4 часа сверхурочных'], 'Теперь нужно 6 часов'))).toBe('количество: в письме 6 часов, раньше в цепочке 4 часа');
  });

  it('тот же текст — изменений нет; новые процент, сумма, срок, обязательство — есть', () => {
    expect(termChanges([first], same)).toEqual([]);
    expect(termChanges([first], higher).map((change) => change.kind)).toEqual(['процент', 'сумма']);
    expect(changeWords(termChanges([first], higher))).toContain('в письме 11%, раньше в цепочке 7%');
    expect(termChanges([first], later).map((change) => change.kind)).toEqual(['срок']);
    expect(termChanges([first, higher], promise).map((change) => change.kind)).toEqual(['обязательство']);
  });

  it('ответ и пересылка — та же цепочка', () => {
    const key = chainKey('a@x.example', 'Условия для «Северный ветер»');
    expect(chainKey('A@x.example', 'Re: Условия для «Северный ветер»')).toBe(key);
    expect(chainKey('a@x.example', 'RE: Fwd: Условия для «Северный ветер»')).toBe(key);
    expect(chainKey('a@x.example', 'Отв: Условия для  «Северный ветер»')).toBe(key);
    expect(chainKey('a@x.example', 'Условия для «Южный ветер»')).not.toBe(key);
  });

  it('без изменений письмо — повтор, с новыми условиями — разбор заново, N1 идёт руководителю', () => {
    const prior = { id: 'x1', status: 'исполнено', summary: 'Скидка 7% согласована' };
    const repeat = enforce(model, same, [], [], prior, termChanges([first], same));
    expect(repeat.kind).toBe('повтор');
    expect(repeat.ask).toBe(false);

    const changed = enforce(model, higher, [], [], prior, termChanges([first], higher));
    expect(changed.kind).toBe('вернуть');
    expect(changed.category).toBe('иное');
    expect(changed.summary).toContain('Условия изменились');
    expect(changed.basis).toContain('это не повтор');

    const point = 'деньги и бюджеты (скидки)';
    const guarded = enforce({ ...model, категория: point }, higher, [point], [], prior, termChanges([first], higher));
    expect(guarded.category).toBe(point);
    expect(guarded.ask).toBe(true);
    expect(guarded.send).toBe(false);

    const asked = 'Прошу скидку 11% вместо прежних условий.';
    const over = enforce(model, asked, [], limitBreaches(asked, [{ area: 'скидка', limit: '5', unit: '%' }]), prior, termChanges([first], asked));
    expect(over.ask).toBe(true);
    expect(over.basis).toContain('выше права');
  });

  it('прежнее решение цепочки — то, что ждёт, иначе самое позднее', () => {
    const at = (day: number) => new Date(Date.UTC(2026, 11, day));
    const rows = [
      { id: 'a', chainKey: 'k', status: 'заменено', createdAt: at(7) },
      { id: 'b', chainKey: 'k', status: 'ждёт', createdAt: at(8) },
      { id: 'c', chainKey: 'k', status: 'исполнено', createdAt: at(9) },
      { id: 'd', chainKey: 'other', status: 'ждёт', createdAt: at(10) },
    ];
    expect(latestDecision(rows, 'k', 'zzz')?.id).toBe('b');
    expect(latestDecision(rows.filter((row) => row.id !== 'b'), 'k', 'zzz')?.id).toBe('c');
    expect(latestDecision(rows, 'none', 'zzz')).toBeNull();
  });

  it('повторы в письмах обоих руководителей не считаются изменением', () => {
    for (const dir of ['data/synthetic', 'data/leader2']) {
      const rows = csvRows(readFileSync(`${dir}/inbox.csv`, 'utf8'));
      const chains = new Map<string, string[]>();
      for (const row of rows) {
        const key = chainKey(row.from_email, row.subject);
        const text = `${row.subject}\n${row.body}`;
        const before = chains.get(key) ?? [];
        if (before.length && before.includes(text)) expect(termChanges(before, text)).toEqual([]);
        chains.set(key, [...before, text]);
      }
    }
  });
});

function csvRows(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell || row.length) rows.push([...row, cell]);
  const lines = rows.filter((line) => line.length > 1 && !line[0].startsWith('#'));
  const [head, ...body] = lines;
  return body.map((line) => Object.fromEntries(head.map((name, index) => [name, line[index] ?? ''])));
}
