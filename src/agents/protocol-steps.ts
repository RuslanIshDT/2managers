// Поручения протокола структурой (сценарий 5): одно поручение — одна задача, статус прошлых задач, письма, новые встречи.
// Имена и сроки берутся из ответа модели и из людей руководителя, в коде их нет.
import { dateWords } from './scene.ts';
import { lateWords, taskTitle } from './focus.ts';

export interface ProtocolStep {
  owner: string;
  task: string;
  due: string;
}

export type PriorStatus = 'сделано' | 'не сделано' | 'просрочено' | 'не обсуждали';

export interface PriorItem {
  n: number;
  status: PriorStatus;
  note: string;
}

export interface AgreedMeeting {
  title: string;
  date: string;
  time: string;
  participants: string[];
}

const PRIOR: Record<string, PriorStatus> = {
  сделано: 'сделано',
  'не сделано': 'не сделано',
  просрочено: 'просрочено',
  'не обсуждали': 'не обсуждали',
};

export function resolveOwner(name: string, known: { name: string }[]): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'не назван';
  const exact = known.find((row) => row.name.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact.name;
  const words = new Set(
    trimmed
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^a-zа-я]+/i)
      .filter((word) => word.length >= 3),
  );
  const hits = known.filter((row) =>
    row.name
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/\s+/)
      .some((part) => part.length >= 3 && words.has(part)),
  );
  return hits.length === 1 ? hits[0].name : 'не назван';
}

export function taskText(task: string, owner: string): string {
  let text = task.replace(/\s+/g, ' ').trim();
  if (owner && owner !== 'не назван') {
    const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^${escaped}\\s*[:\\-—]?\\s*`, 'i'), '').trim();
  }
  return text.slice(0, 120);
}

export function cleanSteps(raw: { owner?: string; task?: string; due?: string }[], known: { name: string }[]): ProtocolStep[] {
  const out: ProtocolStep[] = [];
  for (const row of raw.slice(0, 30)) {
    const owner = resolveOwner(row.owner ?? '', known);
    const task = taskText(row.task ?? '', owner === 'не назван' ? (row.owner ?? '') : owner);
    if (!task) continue;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(row.due ?? '') ? (row.due as string) : '';
    out.push({ owner, task, due });
  }
  return out;
}

export function cleanPrior(raw: { n?: number; status?: string; note?: string }[], taskCount: number): PriorItem[] {
  const seen = new Set<number>();
  const out: PriorItem[] = [];
  for (const row of raw.slice(0, 30)) {
    const n = Math.round(Number(row.n));
    const status = PRIOR[(row.status ?? '').trim().toLowerCase()];
    if (!status || !Number.isInteger(n) || n < 1 || n > taskCount || seen.has(n)) continue;
    seen.add(n);
    out.push({ n, status, note: (row.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
  return out;
}

export function cleanMeetings(raw: { title?: string; date?: string; time?: string; participants?: string[] }[]): AgreedMeeting[] {
  const out: AgreedMeeting[] = [];
  for (const row of raw.slice(0, 8)) {
    const title = (row.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!title) continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(row.date ?? '') ? (row.date as string) : '';
    const time = /^(\d{1,2}):(\d{2})$/.exec(row.time ?? '');
    const hhmm = time && Number(time[1]) < 24 && Number(time[2]) < 60 ? `${time[1].padStart(2, '0')}:${time[2]}` : '';
    const participants = (row.participants ?? []).map((name) => name.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12);
    out.push({ title, date, time: hhmm, participants });
  }
  return out;
}

export function storedSteps(value: unknown): ProtocolStep[] {
  if (!Array.isArray(value)) return [];
  const out: ProtocolStep[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const item = row as { owner?: unknown; task?: unknown; due?: unknown };
    const task = typeof item.task === 'string' ? item.task.trim() : '';
    if (!task) continue;
    const due = typeof item.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due : '';
    const owner = typeof item.owner === 'string' && item.owner.trim() ? item.owner.trim() : 'не назван';
    out.push({ owner, task: task.slice(0, 120), due });
  }
  return out;
}

export function storedPrior(value: unknown): PriorItem[] {
  if (!Array.isArray(value)) return [];
  return cleanPrior(
    value.filter((row) => row && typeof row === 'object') as { n?: number; status?: string; note?: string }[],
    100,
  );
}

export function storedMeetings(value: unknown): AgreedMeeting[] {
  if (!Array.isArray(value)) return [];
  return cleanMeetings(value.filter((row) => row && typeof row === 'object') as { title?: string; date?: string; time?: string; participants?: string[] }[]);
}

export function stepLine(step: ProtocolStep): string {
  return step.due ? `${step.owner}: ${step.task}, до ${dateWords(step.due)}` : `${step.owner}: ${step.task}`;
}

export function priorLine(task: { title: string; owner: string }, item: PriorItem): string {
  const note = item.note ? ` ${item.note}` : '';
  return `${task.title} (${task.owner}): ${item.status}.${note}`.trim().slice(0, 240);
}

export function meetingWords(startsAt: string): string {
  const time = /T(\d{2}):(\d{2})/.exec(startsAt);
  const day = dateWords(startsAt.slice(0, 10));
  return time ? `${day}, ${time[1]}:${time[2]}` : day;
}

export function protocolPlace(meeting: { title: string; startsAt: string } | null): string {
  if (!meeting) return 'Протокол лежит в описании встречи в календаре.';
  return `Протокол лежит в описании встречи в календаре: ${meeting.title}, ${meetingWords(meeting.startsAt)}.`;
}

export function protocolTaskDescription(owner: string, meeting: { title: string; startsAt: string } | null): string {
  const lines = [`Исполнитель: ${owner}.`];
  if (meeting) lines.push(`Встреча: ${meeting.title}, ${meetingWords(meeting.startsAt)}.`);
  lines.push('Протокол лежит в описании этой встречи в календаре.');
  return lines.join('\n');
}

export function openWithMeetings(open: string[], meetings: AgreedMeeting[]): string[] {
  const extra = meetings
    .filter((meeting) => !meeting.date || !meeting.time)
    .map((meeting) => {
      const who = meeting.participants.length ? ` с ${meeting.participants.join(', ')}` : '';
      return `Встреча «${meeting.title}»${who} — нет даты или времени`;
    });
  return [...open, ...extra].slice(0, 8);
}

export interface ScheduledMeeting {
  uid: string;
  date: string;
  time: string;
  title: string;
  participants: string[];
}

export function scheduledMeetings(leaderId: string, protocolId: string, meetings: AgreedMeeting[]): ScheduledMeeting[] {
  return meetings
    .filter((meeting) => meeting.date && meeting.time)
    .map((meeting, index) => ({
      uid: `${leaderId}:protocol-${protocolId}-m${index + 1}`,
      date: meeting.date,
      time: meeting.time,
      title: meeting.title,
      participants: meeting.participants,
    }));
}

export function priorEffects(
  tasks: { externalId: string }[],
  prior: PriorItem[],
  meetingDay: string,
): { closeIds: string[]; comments: { externalId: string; text: string }[] } {
  const closeIds: string[] = [];
  const comments: { externalId: string; text: string }[] = [];
  const when = /^\d{4}-\d{2}-\d{2}$/.test(meetingDay) ? dateWords(meetingDay) : '';
  for (const item of prior) {
    const task = tasks[item.n - 1];
    if (!task) continue;
    if (item.status === 'сделано') closeIds.push(task.externalId);
    if (item.status === 'просрочено') {
      comments.push({ externalId: task.externalId, text: when ? `Просрочено по протоколу ${when}` : 'Просрочено по протоколу' });
    }
  }
  return { closeIds, comments };
}

export function replaceSection(body: string, title: string, lines: string[]): string {
  const start = body.indexOf(title);
  if (start < 0) return body;
  const rest = body.slice(start + title.length);
  const next = rest.search(/\n\n/);
  const tail = next < 0 ? '' : rest.slice(next);
  const block = lines.map((line) => `— ${line}`).join('\n');
  return `${body.slice(0, start)}${title}\n${block}${tail}`;
}

export interface ProtocolLetter {
  toName: string;
  toEmail: string;
  subject: string;
  text: string;
}

function letterHead(name: string, email: string): string {
  const who = email ? `Кому: ${name} <${email}>` : `Кому: ${name}`;
  return `${who}\nСтенд отправляет письма помощника в тестовый ящик, получатель назван выше.`;
}

function phrase(task: string, due: string): string {
  return due ? `${task}, до ${dateWords(due)}` : task;
}

function plain(body: string): string {
  return body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Письмо каждому участнику из оргструктуры и одно руководителю со всеми поручениями.
export function protocolLetters(input: {
  theme: string;
  body: string;
  tasks: { title: string; owner: string; dueOn: string }[];
  participants: string[];
  known: { name: string; email: string }[];
  leaderName: string;
  place: string;
}): ProtocolLetter[] {
  const subject = `Протокол: ${input.theme}`.slice(0, 180);
  const body = plain(input.body);
  const knownByName = new Map(input.known.map((row) => [row.name.toLowerCase(), row]));
  const leaderKey = input.leaderName.trim().toLowerCase();
  const people: { name: string; email: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const key = name.trim().toLowerCase();
    if (!key || key === leaderKey || seen.has(key)) return;
    const person = knownByName.get(key);
    if (!person) return;
    seen.add(key);
    people.push(person);
  };
  for (const name of input.participants) add(resolveOwner(name, input.known));
  for (const task of input.tasks) add(task.owner);
  const of = (name: string) => input.tasks.filter((task) => task.owner.toLowerCase() === name.toLowerCase());
  const letters: ProtocolLetter[] = people.map((person) => {
    const own = of(person.name);
    const assignments = own.length ? ['Ваши поручения:', ...own.map((task) => `— ${phrase(task.title, task.dueOn)}`)].join('\n') : 'Ваши поручения: поручений нет.';
    return { toName: person.name, toEmail: person.email, subject, text: [letterHead(person.name, person.email), assignments, body, input.place].join('\n\n') };
  });
  const leader = knownByName.get(leaderKey);
  const allLines = people.map((person) => {
    const own = of(person.name);
    return own.length ? own.map((task) => `— ${person.name}: ${phrase(task.title, task.dueOn)}`) : [`— ${person.name}: поручений нет`];
  });
  const leaderOwn = of(input.leaderName).map((task) => `— ${input.leaderName}: ${phrase(task.title, task.dueOn)}`);
  const unnamed = input.tasks.filter((task) => task.owner === 'не назван').map((task) => `— не назван: ${phrase(task.title, task.dueOn)}`);
  const leaderBlock = ['Поручения:', ...allLines.flat(), ...leaderOwn, ...unnamed].join('\n');
  letters.push({
    toName: input.leaderName,
    toEmail: leader?.email ?? '',
    subject,
    text: [letterHead(input.leaderName, leader?.email ?? ''), leaderBlock, body, input.place].join('\n\n'),
  });
  return letters;
}

export interface ReminderItem {
  key: string;
  title: string;
  owner: string;
  days: number;
}

const CLOSED = new Set(['сделана', 'закрыта', 'отменена']);

export function reminderItems(
  tasks: { key: string; title: string; owner: string; dueOn: string; status: string }[],
  today: string,
  leaderName: string,
  sent: Set<string>,
): ReminderItem[] {
  return tasks.flatMap((task) => {
    if (CLOSED.has(task.status) || !task.owner || task.owner === leaderName || task.owner === 'не назван') return [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(task.dueOn) || task.dueOn > today || sent.has(task.key)) return [];
    const [year, month, day] = task.dueOn.split('-').map(Number);
    const [nowYear, nowMonth, nowDay] = today.split('-').map(Number);
    const days = Math.round((Date.UTC(nowYear, nowMonth - 1, nowDay) - Date.UTC(year, month - 1, day)) / 86_400_000);
    return [{ key: task.key, title: taskTitle(task.title, task.owner), owner: task.owner, days }];
  });
}

export interface ReminderLetter {
  toName: string;
  toEmail: string;
  subject: string;
  text: string;
  keys: string[];
}

export function reminderLetters(items: ReminderItem[], known: { name: string; email: string }[]): ReminderLetter[] {
  const knownByName = new Map(known.map((row) => [row.name.toLowerCase(), row]));
  const groups = new Map<string, ReminderItem[]>();
  for (const item of items) {
    const list = groups.get(item.owner) ?? [];
    list.push(item);
    groups.set(item.owner, list);
  }
  const letters: ReminderLetter[] = [];
  for (const [owner, rows] of groups) {
    const person = knownByName.get(owner.toLowerCase());
    if (!person) continue;
    const sorted = [...rows].sort((a, b) => b.days - a.days || a.title.localeCompare(b.title, 'ru'));
    const today = sorted.filter((row) => row.days === 0).map((row) => `— ${row.title}`);
    const late = sorted.filter((row) => row.days > 0).map((row) => `— ${row.title} — ${lateWords(row.days)}`);
    const blocks = [letterHead(person.name, person.email)];
    if (today.length) blocks.push(['Срок сегодня:', ...today].join('\n'));
    if (late.length) blocks.push(['Просрочено:', ...late].join('\n'));
    letters.push({ toName: person.name, toEmail: person.email, subject: 'Сроки задач', text: blocks.join('\n\n'), keys: sorted.map((row) => row.key) });
  }
  return letters;
}
