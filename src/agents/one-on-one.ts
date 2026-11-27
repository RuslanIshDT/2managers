// Перед встречей один на один: что сотрудник уже передал и какого действия ждёт от руководителя.
// Имена и формулировки берутся из писем, протоколов и задач, в коде их нет.
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { emails, mailIn, people, protocols, seriesKind } from '../db/schema.ts';
import type { LiveTask } from './live-sources.ts';
import { meetingOfFile } from './protocol-context.ts';
import { dateWords } from './scene.ts';

export interface OneOnOneLine {
  text: string;
  sources: string[];
}

export interface OneOnOneBlock {
  name: string;
  lines: OneOnOneLine[];
}

export interface BriefLetter {
  at: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
}

export interface BriefStep {
  owner: string;
  task: string;
}

export interface BriefProtocol {
  at: string;
  title: string;
  steps: BriefStep[];
}

export interface BriefTask {
  key: string;
  title: string;
  owner: string;
  status: string;
}

export interface BriefMeeting {
  summary: string;
  startsAt: string;
  attendees?: string[];
  kind?: string;
}

export interface BriefInput {
  leaderName: string;
  leaderEmail: string;
  until: string;
  people: { name: string; email: string }[];
  meetings: BriefMeeting[];
  letters: BriefLetter[];
  protocols: BriefProtocol[];
  tasks: BriefTask[];
}

const CLOSED = new Set(['сделана', 'закрыта', 'отменена', 'готово']);
const STOP = new Set([
  'обещаю',
  'обязуюсь',
  'выбрать',
  'сделать',
  'решить',
  'посмотреть',
  'согласовать',
  'утвердить',
  'подписать',
  'назвать',
  'определить',
  'ответить',
  'когда',
  'будут',
  'пришли',
  'пришлет',
  'прислать',
  'после',
  'только',
  'чтобы',
  'нужно',
  'нужен',
  'нужна',
  'нужны',
  'этого',
  'этому',
]);

interface Question {
  person: string;
  action: string;
  at: string;
  waiting: boolean;
  thread: string;
  words: string[];
  sources: string[];
  kind: 'promise' | 'task';
}

export function oneOnOneBrief(input: BriefInput): OneOnOneBlock[] {
  const until = stamp(input.until);
  const day = until.slice(0, 10);
  const people = input.people.filter((person) => person.name.trim() && !sameName(person.name, input.leaderName));
  const visibleLetters = input.letters.filter((letter) => stamp(letter.at) && stamp(letter.at) <= until);
  const visibleProtocols = input.protocols.filter((protocol) => stamp(protocol.at) && stamp(protocol.at) <= until);
  const questions: Question[] = [];
  for (const protocol of visibleProtocols) {
    for (const step of protocol.steps) {
      if (!sameName(step.owner, input.leaderName)) continue;
      const person = personOfText(step.task, people) ?? personOfTitle(protocol.title, people);
      const action = actionFrom(step.task);
      if (!person || !action) continue;
      questions.push(question(person, action, protocol.at, step.task, '', `Протокол ${dateWords(protocol.at)}: ${step.task}`, 'promise'));
    }
  }
  for (const letter of visibleLetters) {
    if (!fromLeader(letter, input)) continue;
    const person = personOfAddress(letter.toEmail, people) ?? personOfText(`${letter.subject} ${letter.body}`, people);
    const action = actionFrom(`${letter.subject}. ${letter.body}`);
    if (!person || !action) continue;
    questions.push(
      question(person, action, letter.at, `${letter.subject} ${letter.body}`, threadOf(letter.subject), `Письмо ${dateWords(letter.at)} «${letter.subject}»`, 'promise'),
    );
  }
  for (const task of input.tasks) {
    if (!sameName(task.owner, input.leaderName) || CLOSED.has(task.status)) continue;
    const person = personOfText(task.title, people);
    const action = actionFrom(task.title) ?? task.title.trim();
    if (!person || !action) continue;
    const key = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(task.key) ? task.key : '';
    const link = key ? ` https://tracker.yandex.ru/${key}` : '';
    questions.push(question(person, action, '1970-01-01T00:00', task.title, '', `Задача${key ? ` ${key}` : ''} «${task.title}»${link}`, 'task'));
  }
  const blocks: OneOnOneBlock[] = [];
  for (const meeting of input.meetings) {
    if (dayOf(meeting.startsAt) !== day || !isPersonalMeeting(meeting.summary, meeting.kind)) continue;
    const named = (meeting.attendees ?? [])
      .map((name) => people.find((row) => sameName(row.name, name)))
      .find((row) => row);
    const personName = named?.name ?? personOfTitle(meeting.summary, people);
    if (!personName) continue;
    const lines = linesFor(personName, questions, visibleLetters, input.tasks, until, input.leaderName, input.leaderEmail);
    if (!lines.length || blocks.some((block) => block.name === personName)) continue;
    blocks.push({ name: personName, lines });
  }
  return blocks;
}

export async function oneOnOneForDay(
  db: Db,
  leaderId: string,
  leaderName: string,
  day: string,
  meetings: { summary: string; startsAt: string; attendees?: string[] }[],
  tasks: LiveTask[] | null,
): Promise<OneOnOneBlock[]> {
  const [staff, kinds, catalog, inbox, rows] = await Promise.all([
    db.select({ name: people.name, email: people.email, role: people.role }).from(people).where(eq(people.leaderId, leaderId)),
    db.select({ seriesKey: seriesKind.seriesKey, kind: seriesKind.kind }).from(seriesKind).where(eq(seriesKind.leaderId, leaderId)),
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
    db.select().from(mailIn).where(eq(mailIn.leaderId, leaderId)),
    db.select().from(protocols).where(and(eq(protocols.leaderId, leaderId), eq(protocols.status, 'утверждён'))),
  ]);
  const leader = staff.find((person) => person.role === 'руководитель') ?? staff.find((person) => sameName(person.name, leaderName));
  const kindOf = new Map(kinds.map((row) => [row.seriesKey, row.kind]));
  const letters: BriefLetter[] = [
    ...catalog.map((row) => ({
      at: row.received,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      toEmail: row.toAddr,
      subject: row.subject,
      body: row.body,
    })),
    ...inbox.map((row) => ({
      at: row.received,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      toEmail: '',
      subject: row.subject,
      body: row.body,
    })),
  ];
  const briefProtocols: BriefProtocol[] = rows.flatMap((row) => {
    const meeting = meetingOfFile(row.source);
    const steps = stepsOf(row.steps);
    if (!steps.length) return [];
    return [{ at: meeting?.startsAt ?? row.createdAt.toISOString(), title: meeting?.title ?? '', steps }];
  });
  return oneOnOneBrief({
    leaderName,
    leaderEmail: leader?.email ?? '',
    until: `${day}T08:30`,
    people: staff.map((person) => ({ name: person.name, email: person.email })),
    meetings: meetings.map((meeting) => ({ ...meeting, kind: kindOf.get(meeting.summary) })),
    letters,
    protocols: briefProtocols,
    tasks: (tasks ?? []).map((task) => ({ key: task.id, title: task.title, owner: task.owner, status: task.status })),
  });
}

function linesFor(
  person: string,
  questions: Question[],
  letters: BriefLetter[],
  tasks: BriefTask[],
  until: string,
  leaderName: string,
  leaderEmail: string,
): OneOnOneLine[] {
  const lines: OneOnOneLine[] = [];
  const seen = new Set<string>();
  for (const item of questions.filter((row) => sameName(row.person, person)).sort((a, b) => a.at.localeCompare(b.at))) {
    const key = item.action.toLowerCase();
    if (seen.has(key)) continue;
    const delivery = item.waiting ? deliveryFor(item, person, letters, until) : null;
    if (item.waiting && !delivery) continue;
    if (closed(item, delivery, letters, tasks, until, leaderName, leaderEmail)) continue;
    seen.add(key);
    const sources = [...item.sources];
    if (delivery) sources.push(`Письмо ${dateWords(delivery.at)} «${delivery.subject}»`);
    lines.push({ text: lineText(person, item.action, delivery, item.kind), sources });
  }
  return lines;
}

function question(person: string, action: string, at: string, raw: string, thread: string, source: string, kind: Question['kind']): Question {
  return {
    person,
    action,
    at: stamp(at),
    waiting: waitsForMaterials(raw),
    thread,
    words: contentWords(raw),
    sources: [source],
    kind,
  };
}

function deliveryFor(item: Question, person: string, letters: BriefLetter[], until: string): BriefLetter | null {
  const found = letters
    .filter((letter) => stamp(letter.at) > item.at && stamp(letter.at) <= until && sameName(letter.fromName, person))
    .filter((letter) => overlaps(item.words, `${letter.subject} ${letter.body}`))
    .sort((a, b) => stamp(a.at).localeCompare(stamp(b.at)));
  return found[0] ?? null;
}

function closed(
  item: Question,
  delivery: BriefLetter | null,
  letters: BriefLetter[],
  tasks: BriefTask[],
  until: string,
  leaderName: string,
  leaderEmail: string,
): boolean {
  const threads = new Set([item.thread, delivery ? threadOf(delivery.subject) : ''].filter(Boolean));
  const after = delivery ? stamp(delivery.at) : item.at;
  const leaderReply = letters.some((letter) => {
    if (!(stamp(letter.at) > after && stamp(letter.at) <= until)) return false;
    if (!isLeader(letter, leaderName, leaderEmail)) return false;
    const sameThread = threads.has(threadOf(letter.subject));
    const answeredInPlace = !item.waiting && overlaps(item.words, `${letter.subject} ${letter.body}`);
    return sameThread || answeredInPlace;
  });
  const done = tasks.some((task) => CLOSED.has(task.status) && sameName(task.owner, leaderName) && overlaps(item.words, task.title));
  return leaderReply || done;
}

function lineText(person: string, action: string, delivery: BriefLetter | null, kind: Question['kind']): string {
  const head = kind === 'task' ? `Нужно: ${lowerFirst(action)}.` : `Вы обещали ${lowerFirst(action)}.`;
  if (!delivery) return kind === 'task' ? head : `${head} Ответа в переписке пока не видно.`;
  const verb = /[ая]$/i.test(firstName(person)) ? 'прислала' : 'прислал';
  const what = firstSentence(delivery.body) || delivery.subject;
  return `${head} ${firstName(person)} ${verb} ${dateWords(delivery.at)}: ${what} Ответа в переписке пока не видно.`;
}

export function isPersonalMeeting(title: string, kind = ''): boolean {
  if (kind === 'один_на_один') return true;
  return /(?:^|[^a-zа-яё0-9])(?:1\s*[:\-]\s*1|один на один)(?![a-zа-яё])/i.test(title);
}

function actionFrom(text: string): string | null {
  const promised = /(?:обещаю|обязуюсь|беру на себя|возьму на себя)\s+([^.\n]+)/i.exec(text);
  if (promised) return cleanAction(promised[1] ?? '');
  const verb = /(?:^|[.!?\n]\s*|^\s*|и\s+)((?:выбрать|сделать|решить|посмотреть|согласовать|утвердить|подписать|назвать|определить|ответить)\s+[^.\n]+)/i.exec(text);
  if (verb) return cleanAction(verb[1] ?? '');
  return null;
}

function cleanAction(raw: string): string {
  return raw
    .split(/,|\sкогда\b|\sпосле\b|\sкак только\b/i)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:]+$/g, '');
}

function waitsForMaterials(text: string): boolean {
  return /пришл|жду|нужн|подготов|как только|когда будут|после того как/i.test(text);
}

function contentWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((word) => word.length >= 5 && !STOP.has(word));
  return [...new Set(words)];
}

function overlaps(words: string[], text: string): boolean {
  if (!words.length) return false;
  const hay = text.toLowerCase().replace(/ё/g, 'е');
  return words.some((word) => hay.includes(word.slice(0, Math.max(5, word.length - 1))));
}

function threadOf(subject: string): string {
  let text = subject.toLowerCase().replace(/ё/g, 'е').trim();
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(/^(re|fwd|fw|отв|ответ|пересыл)\s*:\s*/i, '').trim();
  }
  return text;
}

function fromLeader(letter: BriefLetter, input: BriefInput): boolean {
  return isLeader(letter, input.leaderName, input.leaderEmail);
}

function isLeader(letter: BriefLetter, leaderName: string, leaderEmail: string): boolean {
  if (leaderEmail && letter.fromEmail.toLowerCase() === leaderEmail.toLowerCase()) return true;
  return sameName(letter.fromName, leaderName);
}

function personOfAddress(email: string, people: { name: string; email: string }[]): string | null {
  const found: string[] = email.toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/g) ?? [];
  const hit = people.filter((person) => found.includes(person.email.toLowerCase()));
  return hit.length === 1 ? hit[0].name : null;
}

function personOfText(text: string, people: { name: string }[]): string | null {
  const hits = people.filter((person) => mentioned(person.name, text));
  return hits.length === 1 ? hits[0].name : null;
}

function personOfTitle(title: string, people: { name: string }[]): string | null {
  return personOfText(title, people);
}

function mentioned(name: string, text: string): boolean {
  const last = name.trim().split(/\s+/).pop()?.toLowerCase().replace(/ё/g, 'е') ?? '';
  if (last.length < 4) return false;
  const stem = last.slice(0, Math.max(4, last.length - 2));
  return text.toLowerCase().replace(/ё/g, 'е').includes(stem);
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase().replace(/ё/g, 'е') === right.trim().toLowerCase().replace(/ё/g, 'е');
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const end = clean.search(/[.!?](\s|$)/);
  const sentence = (end === -1 ? clean : clean.slice(0, end + 1)).trim();
  return sentence.length > 140 ? `${sentence.slice(0, 139).trim()}…` : sentence;
}

function stepsOf(value: unknown): BriefStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { owner?: unknown; task?: unknown };
    const task = typeof row.task === 'string' ? row.task.trim() : '';
    const owner = typeof row.owner === 'string' ? row.owner.trim() : '';
    return task ? [{ owner, task }] : [];
  });
}

function dayOf(startsAt: string): string {
  return stamp(startsAt).slice(0, 10);
}

function stamp(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):?(\d{2}))?/.exec(value.trim());
  if (!match) {
    const compact = /^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/.exec(value.trim());
    if (!compact) return '';
    return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4] ?? '00'}:${compact[5] ?? '00'}`;
  }
  return `${match[1]}-${match[2]}-${match[3]}T${match[4] ?? '00'}:${match[5] ?? '00'}`;
}
