// Ключи и тексты для Трекера и Календаря. Имена и темы берутся из строк руководителя, в коде их нет.

export function taskUnique(leaderId: string, externalId: string): string {
  const clean = `${leaderId}-${externalId}`.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 90);
  return `ecompras-${clean}`;
}

export function eventFile(uid: string): string {
  let hash = 2166136261;
  for (const char of uid) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const clean = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  return `${clean || 'event'}-${(hash >>> 0).toString(16)}.ics`;
}

export function relatedSubjects(title: string, subjects: string[]): string[] {
  const words = wordsOf(title);
  const hits: string[] = [];
  for (const subject of subjects) {
    const same = wordsOf(subject).some((word) => words.some((other) => sameWord(word, other)));
    if (!same) continue;
    hits.push(subject);
    if (hits.length === 2) break;
  }
  return hits;
}

export function issueDraft(task: { title: string; ownerName: string; dueOn: string; status: string; source: string }, subjects: string[]): {
  summary: string;
  description: string;
  deadline: string | null;
} {
  const lines = [
    `Исполнитель: ${task.ownerName}.`,
    `Источник: ${task.source}.`,
    task.status ? `Состояние в материалах: ${task.status}.` : '',
    subjects.length ? `Рядом в почте: ${subjects.join('; ')}.` : '',
  ].filter(Boolean);
  return {
    summary: task.title.replace(/\s+/g, ' ').trim().slice(0, 200),
    description: lines.join('\n').slice(0, 2000),
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(task.dueOn) ? task.dueOn : null,
  };
}

export function meetingStart(value: string): Date {
  const [date, time = '10:00'] = value.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1, (hour || 0) - 3, minute || 0));
}

export function standEvent(input: { uid: string; start: Date; minutes: number; summary: string; description: string }): string {
  const end = new Date(input.start.getTime() + Math.max(1, input.minutes) * 60_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ecompras//materials//RU',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Moscow',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0300',
    'TZOFFSETTO:+0300',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${icsText(input.uid)}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART;TZID=Europe/Moscow:${localStamp(input.start)}`,
    `DTEND;TZID=Europe/Moscow:${localStamp(end)}`,
    `SUMMARY:${icsText(input.summary)}`,
    `DESCRIPTION:${icsText(input.description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export function readEvents(xml: string): { uid: string; summary: string; start: string }[] {
  return xml
    .split(/BEGIN:VEVENT/i)
    .slice(1)
    .map((chunk) => {
      const text = chunk.replace(/\r?\n[ \t]/g, '');
      const uid = /^UID:(.*)$/m.exec(text)?.[1] ?? '';
      const summary = /^SUMMARY:(.*)$/m.exec(text)?.[1] ?? '';
      const start = /^DTSTART[^:\r\n]*:(.*)$/m.exec(text)?.[1] ?? '';
      return { uid: unescapeIcs(uid).trim(), summary: unescapeIcs(summary).trim(), start: start.trim() };
    })
    .filter((row) => row.summary);
}

export function attendeeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || !('name' in item)) continue;
    const name = item.name;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
    if (names.length === 8) break;
  }
  return names;
}

function sameWord(left: string, right: string): boolean {
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 6 && longer.startsWith(shorter);
}

function wordsOf(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((word) => word.length >= 6);
}

function localStamp(value: Date): string {
  const shifted = new Date(value.getTime() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

function utcStamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (char) => `\\${char}`).slice(0, 400);
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1');
}
