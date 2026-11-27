// Правила подтверждения и пределы полномочий — из данных руководителя, не из перечня в коде.
import { profileItems } from './free-time.ts';

export const OTHER = 'иное';

export interface LimitRow {
  area: string;
  limit: string;
  unit: string;
}

export interface LimitBreach {
  area: string;
  asked: number;
  limit: number;
  unit: string;
}

export function confirmationPoints(profile: string): string[] {
  return profileItems(profile, /^Никогда без подтверждения/i);
}

export function categoryChoices(points: string[]): string[] {
  return [...points, OTHER];
}

function stem(word: string): string {
  const clean = word.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
  if (clean.length < 4) return '';
  return clean.slice(0, Math.min(clean.length, Math.max(5, clean.length - 2)));
}

function stems(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/_/g, ' ')
    .split(/[^a-zа-я0-9]+/i)
    .map(stem)
    .filter((word) => word.length >= 5);
}

function stemsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 6 || right.length < 6) return false;
  return left.startsWith(right) || right.startsWith(left);
}

// Слаг из эталона («кадры») совпадает с пунктом профиля, если каждое его слово есть в названии пункта.
export function categoryMatchesPoint(category: string, point: string): boolean {
  if (category.trim().toLowerCase() === point.trim().toLowerCase()) return true;
  const head = (point.split('(')[0] ?? point).trim();
  const wanted = stems(category);
  const words = stems(head);
  if (!wanted.length || !words.length) return false;
  return wanted.every((word) => words.some((headWord) => stemsMatch(word, headWord)));
}

export function leaderMustConfirm(category: string, points: string[]): boolean {
  const value = category.trim();
  if (!value || value.toLowerCase() === OTHER) return false;
  return points.some((point) => categoryMatchesPoint(value, point));
}

export function canonicalCategory(raw: string, points: string[]): string {
  const value = raw.trim();
  if (!value) return OTHER;
  const exact = points.find((point) => point.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  return value.toLowerCase() === OTHER ? OTHER : OTHER;
}

export function normalizeUnit(unit: string): string {
  const value = unit.trim().toLowerCase();
  if (value === '%' || value.includes('%')) return '%';
  if (value.startsWith('ч') || value.startsWith('час')) return 'ч';
  if (value.includes('₽') || value.startsWith('руб')) return '₽';
  return '';
}

export function formatAmount(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) >= 1000) return new Intl.NumberFormat('ru-RU').format(value);
  return String(value);
}

function areaAt(text: string, area: string): number {
  const words = stems(area);
  if (!words.length) return -1;
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  let best = -1;
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at < 0) return -1;
    if (best < 0 || at < best) best = at;
  }
  return best;
}

function amounts(text: string, unit: string): { value: number; at: number }[] {
  const norm = normalizeUnit(unit);
  const pattern =
    norm === '%'
      ? /(\d+(?:[.,]\d+)?)\s*%/g
      : norm === '₽'
        ? /(\d{1,3}(?:[ \u00a0]\d{3})+|\d+(?:[.,]\d+)?)[\s\u00a0]*(?:₽|руб(?:\.|лей|ля|ль)?)/gi
        : norm === 'ч'
          ? /(\d+(?:[.,]\d+)?)\s*(?:ч\b|час)/gi
          : null;
  if (!pattern) return [];
  const found: { value: number; at: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = (match[1] ?? '').replace(/[ \u00a0]/g, '').replace(',', '.');
    const value = Number(raw);
    if (Number.isFinite(value) && match.index !== undefined) found.push({ value, at: match.index });
  }
  return found;
}

// Число с единицей предела, ближайшее к названию области. Чужое число в том же письме не берётся.
export function nearestAmount(text: string, area: string, unit: string): number | null {
  const at = areaAt(text, area);
  if (at < 0) return null;
  const nums = amounts(text, unit);
  if (!nums.length) return null;
  nums.sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at) || a.at - b.at);
  return nums[0]?.value ?? null;
}

export function limitBreaches(text: string, rows: LimitRow[]): LimitBreach[] {
  const breaches: LimitBreach[] = [];
  for (const row of rows) {
    const limit = Number(String(row.limit).replace(/\s/g, '').replace(',', '.'));
    const unit = normalizeUnit(row.unit);
    if (!Number.isFinite(limit) || !unit) continue;
    const asked = nearestAmount(text, row.area, unit);
    if (asked !== null && asked > limit) breaches.push({ area: row.area, asked, limit, unit });
  }
  return breaches;
}

export function breachBasis(rows: LimitBreach[]): string {
  return rows
    .map((row) => {
      const mark = row.unit === '%' ? '%' : ` ${row.unit}`;
      return `${row.area} ${formatAmount(row.asked)}${mark} выше права ${formatAmount(row.limit)}${mark}`;
    })
    .join('; ');
}

export function withinLimit(text: string, area: string, limit: number, unit: string): boolean {
  const asked = nearestAmount(text, area, unit);
  return asked !== null && asked <= limit;
}

export function unitInText(text: string): string {
  if (text.includes('%')) return '%';
  if (/₽|руб/i.test(text)) return '₽';
  if (/(?:^|[^\d])\d+(?:[.,]\d+)?\s*(?:ч\b|час)/i.test(text)) return 'ч';
  return '';
}
