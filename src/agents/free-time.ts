// Освобождённое время (K15, W1): куда его отдать и какие встречи серии освобождаются.
// Приоритеты берутся из профиля руководителя и матрицы отдела, в коде имён и целей нет.

export interface FreeUse {
  id: string;
  title: string;
  summary: string;
  why: string;
}

export const LEAVE_FREE = 'свободно';

// Список пунктов раздела профиля: «- пункт;» или «1. пункт».
export function profileItems(profile: string, heading: RegExp): string[] {
  const part = profile.split(/^## /m).find((chunk) => heading.test(chunk.split('\n')[0] ?? ''));
  if (!part) return [];
  return part
    .split('\n')
    .slice(1)
    .map((line) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)?.[1] ?? '')
    .map((item) => item.trim().replace(/[;,.]+$/, '').trim())
    .filter(Boolean);
}

function upper(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// Варианты: пункты «Куда направить освобождённое время», иначе цели квартала.
// Пункт про встречи один на один раскрывается в людей, которым матрица отдела рекомендует разговор.
export function freeUses(profile: string, matrix: { name: string; cell: string; quiet: boolean; basis: string }[]): FreeUse[] {
  const uses: FreeUse[] = [];
  const spend = profileItems(profile, /освобожд/i);
  const items = spend.length ? spend.map((item) => ({ item, from: 'профиль: куда направить освобождённое время' })) : profileItems(profile, /^цели/i).map((item) => ({ item, from: 'профиль: цель квартала' }));
  for (const [index, { item, from }] of items.entries()) {
    if (/один на один|1:1|one-on-one/i.test(item)) {
      const people = matrix
        .filter((row) => row.cell === 'один_на_один' || row.cell === 'помочь')
        .sort((a, b) => Number(b.quiet) - Number(a.quiet) || Number(b.cell === 'один_на_один') - Number(a.cell === 'один_на_один'));
      for (const person of people) {
        uses.push({
          id: `one:${person.name}`,
          title: `Встреча один на один: ${person.name}`,
          summary: `Один на один: ${person.name}`,
          why: `Матрица отдела: ${person.basis}`,
        });
      }
      if (people.length) continue;
    }
    const goal = from.endsWith('цель квартала');
    uses.push({
      id: `use:${index + 1}`,
      title: upper(item),
      summary: goal ? `Цель: ${item}` : `Время на ${item}`,
      why: upper(from),
    });
  }
  uses.push({ id: LEAVE_FREE, title: 'Оставить время свободным', summary: '', why: 'Время просто не занято встречей' });
  return uses;
}

export interface SeriesMeeting {
  uid: string;
  summary: string;
  startsAt: string;
  minutes: number;
}

// Освобождаются встречи серии с сегодняшнего дня сцены: прошедшие уже состоялись.
export function slotsToFree<T extends SeriesMeeting>(meetings: T[], seriesKey: string, today: string): T[] {
  return meetings
    .filter((meeting) => meeting.summary === seriesKey && meeting.startsAt.slice(0, 10) >= today)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export interface FreedSlot {
  meetingUid: string;
  useSummary: string;
}

// Календарь после отпущенных серий: освобождённая встреча заменена блоком приоритета или убрана.
// goal: блок отдан приоритету руководителя и считается временем на цели (K4).
export function calendarAfter<T extends { uid: string; minutes: number; summary: string; startsAt: string }>(
  meetings: T[],
  freed: FreedSlot[],
): { uid: string; minutes: number; summary: string; startsAt: string; goal: boolean }[] {
  const byUid = new Map(freed.map((slot) => [slot.meetingUid, slot]));
  return meetings.flatMap((meeting): { uid: string; minutes: number; summary: string; startsAt: string; goal: boolean }[] => {
    const slot = byUid.get(meeting.uid);
    if (!slot) return [{ uid: meeting.uid, minutes: meeting.minutes, summary: meeting.summary, startsAt: meeting.startsAt, goal: false }];
    if (!slot.useSummary) return [];
    return [{ uid: `free:${meeting.uid}`, minutes: meeting.minutes, summary: slot.useSummary, startsAt: meeting.startsAt, goal: true }];
  });
}

export function blockDescription(input: { seriesKey: string; change: string; why: string }): string {
  return [
    `ИИ-помощник: серия «${input.seriesKey}» отпущена, время отдано приоритету руководителя.`,
    input.change ? `Почему серия отпущена: ${input.change}` : '',
    input.why ? `Почему этот приоритет: ${input.why}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 10;
  const hundred = n % 100;
  const word = tail === 1 && hundred !== 11 ? one : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? few : many;
  return `${n} ${word}`;
}

export function minutesWords(minutes: number): string {
  if (minutes < 60) return plural(minutes, 'минута', 'минуты', 'минут');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${plural(hours, 'час', 'часа', 'часов')} ${plural(rest, 'минута', 'минуты', 'минут')}` : plural(hours, 'час', 'часа', 'часов');
}
