import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { goalMinutes } from '../src/agents/focus.ts';
import { calendarAfter, freeUses, LEAVE_FREE, profileItems, slotsToFree } from '../src/agents/free-time.ts';
import { freeBlock, meetingEvent } from '../src/agents/stand-sync.ts';
import { hrefsByUid } from '../src/yandex/calendar.ts';

const matrix = [
  { name: 'Анна Первая', cell: 'не_трогать', quiet: false, basis: 'Не трогать.' },
  { name: 'Борис Второй', cell: 'помочь', quiet: false, basis: 'Помочь по существу.' },
  { name: 'Вера Третья', cell: 'один_на_один', quiet: true, basis: 'Встреча один на один. Тихая проблема.' },
];

describe('T57: освобождённое время после «Отпустить»', () => {
  it('варианты — из раздела профиля, встреча один на один раскрыта в людей матрицы, тихая проблема первой', () => {
    const profile = '# П\n\n## Куда направить освобождённое время\nЦель — освободить часы на:\n- стратегию направления;\n- встречи с командой один на один;\n- клиентов и партнёров.\n\n## Другое\n- не это';
    const uses = freeUses(profile, matrix);
    expect(uses.map((row) => row.title)).toEqual([
      'Стратегию направления',
      'Встреча один на один: Вера Третья',
      'Встреча один на один: Борис Второй',
      'Клиентов и партнёров',
      'Оставить время свободным',
    ]);
    expect(uses[0]?.summary).toBe('Время на стратегию направления');
    expect(uses[1]?.summary).toBe('Один на один: Вера Третья');
    expect(uses[1]?.why).toContain('Тихая проблема');
    expect(uses.at(-1)?.id).toBe(LEAVE_FREE);
  });

  it('без списка в разделе — цели квартала; профили обоих руководителей дают варианты без правки кода', () => {
    const marina = readFileSync('data/leader2/leader_profile.md', 'utf8');
    const ivan = readFileSync('data/synthetic/leader_profile.md', 'utf8');
    const goals = profileItems(marina, /^цели/i);
    expect(goals.length).toBeGreaterThan(0);
    const marinaUses = freeUses(marina, []);
    expect(marinaUses.slice(0, goals.length).map((row) => row.summary)).toEqual(goals.map((goal) => `Цель: ${goal}`));
    const ivanUses = freeUses(ivan, matrix);
    expect(ivanUses.some((row) => row.id === 'one:Вера Третья')).toBe(true);
    expect(ivanUses.length).toBeGreaterThan(3);
  });

  it('освобождаются встречи серии с сегодняшнего дня сцены, прошедшие остаются', () => {
    const meetings = [
      { uid: 'a', summary: 'Статус', startsAt: '2026-12-07T11:00', minutes: 60 },
      { uid: 'b', summary: 'Статус', startsAt: '2026-12-14T11:00', minutes: 60 },
      { uid: 'c', summary: 'Другое', startsAt: '2026-12-14T12:00', minutes: 30 },
      { uid: 'd', summary: 'Статус', startsAt: '2026-12-11T09:00', minutes: 30 },
    ];
    expect(slotsToFree(meetings, 'Статус', '2026-12-11').map((row) => row.uid)).toEqual(['d', 'b']);
  });

  it('после отпуска встреча заменена блоком приоритета, и доля календаря на цели растёт', () => {
    const meetings = [
      { uid: 'a', summary: 'Статус продаж', startsAt: '2026-12-14T11:00', minutes: 60 },
      { uid: 'b', summary: 'Статус продаж', startsAt: '2026-12-21T11:00', minutes: 60 },
      { uid: 'c', summary: 'Планёрка', startsAt: '2026-12-14T10:00', minutes: 30 },
    ];
    const after = calendarAfter(meetings, [
      { meetingUid: 'a', useSummary: 'Один на один: Вера Третья' },
      { meetingUid: 'b', useSummary: '' },
    ]);
    expect(after.map((row) => row.summary)).toEqual(['Один на один: Вера Третья', 'Планёрка']);
    const before = goalMinutes(meetings, ['маркетинг']);
    const now = goalMinutes(after, ['маркетинг']);
    expect(before.onGoal).toBe(0);
    expect(now).toEqual({ onGoal: 60, total: 90, percent: 67 });
  });

  it('блок встаёт в то же время, что встреча, под своим UID и в другой файл', () => {
    const meeting = { uid: 'm1', summary: 'Статус', startsAt: '2026-12-14T11:00', minutes: 60, organizer: '', attendees: [], leaderId: 'x', endsAt: '' };
    const original = meetingEvent('x', meeting, []);
    const block = freeBlock('x', meeting, { seriesKey: 'Статус', useSummary: 'Время на стратегию направления' });
    expect(block.file).not.toBe(original.file);
    expect(block.ics).toContain('UID:x:free:m1');
    expect(block.ics).toContain('DTSTART;TZID=Europe/Moscow:20261214T110000');
    expect(block.ics).toContain('DTEND;TZID=Europe/Moscow:20261214T120000');
    expect(block.ics).toContain('SUMMARY:Время на стратегию направления');
    expect(block.ics).toContain('ИИ-помощник');
  });

  it('адрес события в календаре находится по UID: Яндекс хранит его не под именем файла из PUT', () => {
    const xml = [
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/calendars/u/ecompras/x%3Am1.ics</d:href>',
      '<d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x:m1\r\nSUMMARY:Статус\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response>',
      '<d:response><d:href>/calendars/u/ecompras/x%3Afree%3Am1.ics</d:href><d:propstat><d:prop><c:calendar-data>BEGIN:VEVENT\nUID:x:free:m1\nEND:VEVENT</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>',
    ].join('');
    const hrefs = hrefsByUid(xml);
    expect(hrefs.get('x:m1')).toBe('/calendars/u/ecompras/x%3Am1.ics');
    expect(hrefs.get('x:free:m1')).toBe('/calendars/u/ecompras/x%3Afree%3Am1.ics');
  });
});
