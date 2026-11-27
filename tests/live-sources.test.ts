import { describe, expect, it } from 'vitest';
import { meetingsFromEvents, tasksFromIssues } from '../src/agents/live-sources.ts';
import { readMeetings } from '../src/agents/materials.ts';
import { renderMorning } from '../src/agents/focus.ts';

const issue = (over: Partial<Parameters<typeof tasksFromIssues>[0][number]>) => ({
  key: 'Q-1',
  summary: 'Задача',
  description: '',
  deadline: '2026-12-13',
  unique: '',
  status: 'Открыт',
  open: true,
  ...over,
});

describe('утро из Трекера и календаря', () => {
  it('задачи: свои по ключу помощника, исполнитель из описания, поставленные руками — владельцу стенда', () => {
    const issues = [
      issue({ key: 'Q-1', summary: 'Бюджет', unique: 'ecompras-x-t1', description: 'Исполнитель: Пётр Первый.\nИсточник: файл.' }),
      issue({ key: 'Q-2', summary: 'Отчёт', unique: 'ecompras-x-t2', description: 'Исполнитель: Вера Вторая.' }),
      issue({ key: 'Q-3', summary: 'Чужой руководитель', unique: 'ecompras-y-t1', description: 'Исполнитель: Пётр Первый.' }),
      issue({ key: 'Q-4', summary: 'Поставил руками', unique: '', description: 'Позвонить партнёру' }),
      issue({ key: 'Q-5', summary: 'Закрыта', unique: 'ecompras-x-t3', open: false }),
    ];
    const owner = tasksFromIssues(issues, 'x', 'Пётр Первый', true);
    expect(owner.map((row) => [row.title, row.owner])).toEqual([
      ['Бюджет', 'Пётр Первый'],
      ['Отчёт', 'Вера Вторая'],
      ['Поставил руками', 'Пётр Первый'],
    ]);
    // Второй руководитель не видит ни чужих задач, ни поставленных руками.
    expect(tasksFromIssues(issues, 'y', 'Ирина', false).map((row) => row.title)).toEqual(['Чужой руководитель']);
  });

  it('встречи: время по Москве и длительность из календаря, блок освобождённого времени — на цели', () => {
    const xml = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:x:ev1@company.example',
      'DTSTART;TZID=Europe/Moscow:20261211T100000',
      'DTEND;TZID=Europe/Moscow:20261211T103000',
      'SUMMARY:Планёрка &amp; синк',
      'END:VEVENT',
      'BEGIN:VTIMEZONE',
      'DTSTART:19700101T000000',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:abc-123@yandex.ru',
      'DTSTART:20261211T120000Z',
      'DURATION:PT1H30M',
      'SUMMARY:Поставил руками',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:x:free:ev2',
      'DTSTART;TZID=Europe/Moscow:20261214T110000',
      'DTEND;TZID=Europe/Moscow:20261214T120000',
      'SUMMARY:Один на один: Вера',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:y:ev9',
      'DTSTART;VALUE=DATE:20261211',
      'SUMMARY:Весь день',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = readMeetings(xml);
    expect(events).toEqual([
      { uid: 'x:ev1@company.example', summary: 'Планёрка & синк', startsAt: '2026-12-11T10:00', minutes: 30 },
      { uid: 'abc-123@yandex.ru', summary: 'Поставил руками', startsAt: '2026-12-11T15:00', minutes: 90 },
      { uid: 'x:free:ev2', summary: 'Один на один: Вера', startsAt: '2026-12-14T11:00', minutes: 60 },
    ]);
    const mine = meetingsFromEvents(events, 'x', ['x', 'y'], true);
    expect(mine.map((row) => [row.summary, row.goal])).toEqual([
      ['Планёрка & синк', false],
      ['Поставил руками', false],
      ['Один на один: Вера', true],
    ]);
    expect(meetingsFromEvents(events, 'y', ['x', 'y'], false)).toEqual([]);
  });

  it('если Трекер не ответил, сообщение говорит, откуда взяты задачи', () => {
    const text = renderMorning({
      today: '2026-12-11',
      waiting: [],
      ownWeek: [],
      plan: null,
      returned: [],
      overdue: [],
      todayMeetings: [],
      openItems: [],
      share: { onGoal: 0, total: 0, percent: 0 },
      notes: ['Трекер не ответил (Трекер ответил 503) — задачи взяты из базы системы.'],
    });
    expect(text.endsWith('Трекер не ответил (Трекер ответил 503) — задачи взяты из базы системы.')).toBe(true);
  });
});
