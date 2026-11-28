// Дата сцены руководителя: файл scene.csv в его каталоге. Без файла сцена идёт по реальной дате.
// «Сегодня», «вчера», сколько ждёт решение и просрочки считаются от неё; время суток — настоящее, по Москве.
import { readFileSync } from 'node:fs';

const DAY = 86_400_000;
const MSK = 3 * 60 * 60 * 1000;
const cache = new Map<string, string | null>();

export function parseSceneFile(text: string): string | null {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const value = rows.find((line) => line !== 'today') ?? '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function sceneDay(leaderId: string, base = 'data'): string | null {
  if (cache.has(leaderId)) return cache.get(leaderId) ?? null;
  let day: string | null = null;
  try {
    day = parseSceneFile(readFileSync(`${base}/${leaderId}/scene.csv`, 'utf8'));
  } catch {
    day = null;
  }
  cache.set(leaderId, day);
  return day;
}

export function moscowDay(at: Date): string {
  return new Date(at.getTime() + MSK).toISOString().slice(0, 10);
}

export function sceneOffset(day: string | null, real: Date = new Date()): number {
  if (!day) return 0;
  const [y, m, d] = day.split('-').map(Number);
  const [ry, rm, rd] = moscowDay(real).split('-').map(Number);
  return Date.UTC(y, m - 1, d) - Date.UTC(ry, rm - 1, rd);
}

export interface SceneClock {
  day: string | null;
  offset: number;
  now: Date;
  today: string;
}

export function sceneClock(day: string | null, real: Date = new Date()): SceneClock {
  const offset = sceneOffset(day, real);
  const now = new Date(real.getTime() + offset);
  return { day, offset, now, today: moscowDay(now) };
}

export function clockFor(leaderId: string, real: Date = new Date()): SceneClock {
  return sceneClock(sceneDay(leaderId), real);
}

export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

// Предыдущий рабочий день: после понедельника — пятница.
export function previousWorkday(day: string): string {
  let prev = shiftDay(day, -1);
  for (let i = 0; i < 3; i += 1) {
    const weekday = new Date(`${prev}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) break;
    prev = shiftDay(prev, -1);
  }
  return prev;
}

// «2026-12-10 12:52» — время по Москве в данных руководителя.
export function parseMoscow(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d, hh, mm] = match.map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - MSK);
}

export function moscowStamp(at: Date): string {
  return new Date(at.getTime() + MSK).toISOString().slice(0, 16).replace('T', ' ');
}

// Время письма на сцене: письмо из данных руководителя несёт своё время, живое письмо сдвигается на дату сцены.
// Живая дата (письмо из «Отправленных», создание и закрытие задачи) на часах сцены. Без сдвига — как есть.
export function onSceneClock(value: string, clock: SceneClock): string {
  if (!value.trim() || clock.offset === 0) return value;
  const parsed = Date.parse(value);
  const shifted = Number.isNaN(parsed) ? letterMoment(value, false, clock) : new Date(parsed + clock.offset);
  if (Number.isNaN(shifted.getTime())) return value;
  return moscowStamp(shifted);
}

export function letterMoment(received: string, marked: boolean, clock: SceneClock): Date {
  const own = parseMoscow(received);
  if (marked && own) return own;
  const parsed = own ?? new Date(received);
  const real = Number.isNaN(parsed.getTime()) ? new Date(clock.now.getTime() - clock.offset) : parsed;
  return new Date(real.getTime() + clock.offset);
}

export function waitedDays(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY));
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// «2026-12-13» → «13 декабря».
export function dateWords(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ''}`.trim();
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// Подпись в кабинете: от какого дня считаются «сегодня» и «ждёт».
export function sceneWords(leaderId: string): string {
  const day = sceneDay(leaderId);
  if (!day) return '';
  const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? '';
  return `Сегодня в данных руководителя: ${weekday}, ${dateWords(day)} ${day.slice(0, 4)}`;
}
