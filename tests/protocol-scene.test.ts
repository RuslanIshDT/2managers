import { describe, expect, it } from 'vitest';
import { dueOf, meetingOfSource, nextOfSeries, ownerOf, protocolRelease } from '../src/agents/protocol.ts';

const known = [
  { name: 'Ольга Смирнова', email: 'p02@company.example' },
  { name: 'Сергей Морозов', email: 'p05@company.example' },
  { name: 'Мария Лебедева', email: 'p06@company.example' },
];

describe('протокол по встрече руководителя T45', () => {
  it('встречу берёт из имени файла, следующую — из той же серии календаря', () => {
    const meeting = meetingOfSource('2026-12-10T10-00 Планёрка направления-transcript.txt');
    expect(meeting).toEqual({ title: 'Планёрка направления', startsAt: '2026-12-10T10:00' });
    const rows = [
      { uid: 'a', startsAt: '2026-12-10T10:00', minutes: 30, summary: 'Планёрка направления' },
      { uid: 'c', startsAt: '2026-12-14T10:00', minutes: 30, summary: 'Планёрка направления' },
      { uid: 'b', startsAt: '2026-12-11T10:00', minutes: 30, summary: 'Планёрка направления' },
      { uid: 'x', startsAt: '2026-12-11T09:00', minutes: 60, summary: 'Другое' },
    ];
    expect(nextOfSeries(meeting, rows)?.uid).toBe('b');
    expect(meetingOfSource('случайный файл.txt')).toBeNull();
  });

  it('исполнитель — человек отдела по полному имени или однозначному имени, срок из текста', () => {
    expect(ownerOf('Ольга Смирнова отправит КП до 14 декабря', [], known)).toBe('Ольга Смирнова');
    expect(ownerOf('Сергей выходит на юристов сегодня', [], known)).toBe('Сергей Морозов');
    expect(ownerOf('Сверить цифры', [], known)).toBe('не назван');
    expect(dueOf('Ольга Смирнова отправит КП до 14 декабря', '2026-12-10', '2026')).toBe('2026-12-14');
    expect(dueOf('Обновить прогноз сегодня', '2026-12-10', '2026')).toBe('2026-12-10');
    expect(dueOf('Подготовить график до 15.12', '2026-12-10', '2026')).toBe('2026-12-15');
    expect(dueOf('Подумать', '2026-12-10', '2026')).toBeNull();
  });

  it('встреча после утверждения — следующая встреча серии с открытыми вопросами в повестке', () => {
    const body = [
      'Планёрка направления',
      '',
      'Участники: Ольга Смирнова, Сергей Морозов.',
      '',
      'Дальше:',
      '— Ольга Смирнова отправит КП до 14 декабря.',
      '— Сергей Морозов согласует договор.',
      '',
      'Открытые вопросы:',
      '— Скидка «Ромашке».',
    ].join('\n');
    const next = { uid: 'meet-11', startsAt: '2026-12-11T10:00', minutes: 30, summary: 'Планёрка направления' };
    const release = protocolRelease(body, known, new Date('2026-12-10T08:00:00Z'), 'abc', next, '2026-12-10', 'synthetic');
    expect(release.eventUid).toBe('synthetic:meet-11');
    expect(release.ics).toContain('UID:synthetic:meet-11\r\n');
    expect(release.ics).toContain('DTSTART:20261211T070000Z');
    expect(release.ics).toContain('Открытые вопросы прошлого протокола: Скидка «Ромашке».');
    expect(release.tasks).toEqual([
      { title: 'Ольга Смирнова отправит КП до 14 декабря.', owner: 'Ольга Смирнова', dueOn: '2026-12-14' },
      { title: 'Сергей Морозов согласует договор.', owner: 'Сергей Морозов', dueOn: '2026-12-11' },
    ]);
    expect(release.text).toContain('Следующая встреча: Планёрка направления, 11 декабря, 10:00 по Москве');
    expect(release.text).toContain('Ольга Смирнова <p02@company.example>');
  });
});

describe('срок составного шага', () => {
  it('берёт самый ранний срок', () => {
    expect(dueOf('Ольга Смирнова: сегодня прислать варианты; до 14 декабря отправить КП', '2026-12-10', '2026')).toBe('2026-12-10');
  });
});
