// Перед встречей один на один модель решает, ждёт ли сотрудник действия руководителя.
// Код только собирает источники и проверяет, что названные в ответе записи есть в собранном списке.
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { emails, mailIn, people, protocols, seriesKind, tasks as taskTable } from '../db/schema.ts';
import { callJson, type JsonSchema } from '../llm.ts';
import type { LiveTask } from './live-sources.ts';
import { meetingOfFile } from './protocol-context.ts';
import { dateWords } from './scene.ts';
import { mailConfig, readOutgoing } from '../mail.ts';

export interface BriefSource {
  label: string;
  href: string;
}

export interface OneOnOneLine {
  text: string;
  sources: BriefSource[];
}

export interface OneOnOneBlock {
  name: string;
  lines: OneOnOneLine[];
}

export interface BriefLetter {
  id: string;
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
  id: string;
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
  leaderMailbox: string;
  origin: string;
  until: string;
  people: { name: string; email: string }[];
  meetings: BriefMeeting[];
  letters: BriefLetter[];
  protocols: BriefProtocol[];
  tasks: BriefTask[];
}

export interface PacketSource {
  id: string;
  label: string;
  href: string;
  text: string;
}

export interface MeetingPacket {
  name: string;
  summary: string;
  sources: PacketSource[];
}

export interface TurnVerdict {
  waiting: boolean;
  action: string;
  sourceIds: string[];
}

const CLOSED = new Set(['сделана', 'закрыта', 'отменена', 'готово']);
const LETTER_CAP = 12;

const verdictZod = z.object({
  ждёт: z.boolean(),
  действие: z.string().max(300),
  источники: z.array(z.string().max(120)).max(8),
});

const verdictSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ждёт', 'действие', 'источники'],
  properties: {
    ждёт: { type: 'boolean' },
    действие: { type: 'string' },
    источники: { type: 'array', items: { type: 'string' } },
  },
};

export function briefPackets(input: BriefInput): MeetingPacket[] {
  const until = stamp(input.until);
  const day = until.slice(0, 10);
  const people = input.people.filter((person) => person.name.trim() && !sameName(person.name, input.leaderName));
  const packets: MeetingPacket[] = [];
  for (const meeting of input.meetings) {
    if (dayOf(meeting.startsAt) !== day || !isPersonalMeeting(meeting.summary, meeting.kind)) continue;
    const named = (meeting.attendees ?? []).map((name) => people.find((row) => sameName(row.name, name))).find((row) => row);
    const person = named ?? people.find((row) => personOfTitle(meeting.summary, [row]) === row.name);
    if (!person || packets.some((packet) => sameName(packet.name, person.name))) continue;
    packets.push({ name: person.name, summary: meeting.summary, sources: sourcesFor(person, input, until) });
  }
  return packets;
}

export function blocksFromVerdicts(packets: MeetingPacket[], verdicts: TurnVerdict[]): OneOnOneBlock[] {
  return packets.flatMap((packet, index) => {
    const verdict = verdicts[index];
    if (!verdict?.waiting || !verdict.action.trim()) return [];
    const sources = verdict.sourceIds.flatMap((id) => {
      const source = packet.sources.find((row) => row.id === id);
      return source ? [{ label: source.label, href: source.href }] : [];
    });
    if (!sources.length) return [];
    return [{ name: packet.name, lines: [{ text: verdict.action.trim(), sources }] }];
  });
}

export async function judgeTurn(leaderId: string, packet: MeetingPacket): Promise<TurnVerdict> {
  const list = packet.sources.map((source) => `${source.id} | ${source.label} | ${clip(source.text)}`).join('\n');
  const result = await callJson<unknown>({
    purpose: `one-on-one:${leaderId}:${packet.name}`,
    system: [
      'Ты решаешь по источникам, ждёт ли сотрудник к этой встрече один на один действия руководителя.',
      'Ждёт, если свою часть сотрудник уже передал и ход за руководителем.',
      'Не ждёт, если сотрудник ещё не передал свою часть или руководитель уже закрыл вопрос.',
      'действие — одно короткое предложение, чего ждут. Пустая строка, если не ждёт.',
      'источники — id записей, на которых основан ответ. Только id из списка, без новых.',
    ].join(' '),
    user: `Встреча: ${packet.summary}. Сотрудник: ${packet.name}.\n${list || 'Источников нет.'}`,
    schemaName: 'one_on_one',
    schema: verdictSchema,
  });
  const parsed = verdictZod.safeParse(result.data);
  if (!parsed.success) return { waiting: false, action: '', sourceIds: [] };
  return { waiting: parsed.data.ждёт, action: parsed.data.действие.trim(), sourceIds: parsed.data.источники };
}

export async function oneOnOneBrief(
  input: BriefInput,
  judge: (packet: MeetingPacket) => Promise<TurnVerdict> = (packet) => judgeTurn('brief', packet),
): Promise<OneOnOneBlock[]> {
  const packets = briefPackets(input);
  const verdicts: TurnVerdict[] = [];
  for (const packet of packets) {
    try {
      verdicts.push(await judge(packet));
    } catch (error) {
      console.error('Сводка к встрече не собрана', error instanceof Error ? error.message : error);
      verdicts.push({ waiting: false, action: '', sourceIds: [] });
    }
  }
  return blocksFromVerdicts(packets, verdicts);
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
  let outgoing: BriefLetter[] = [];
  try {
    outgoing = (await readOutgoing()).map((row) => ({
      id: row.id,
      at: row.received,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      toEmail: (row.to ?? []).join(' '),
      subject: row.subject,
      body: row.body,
    }));
  } catch (error) {
    console.error('Исходящие не прочитаны', error instanceof Error ? error.message : error);
  }
  const letters: BriefLetter[] = [
    ...catalog.map((row) => ({
      id: row.externalId,
      at: row.received,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      toEmail: row.toAddr,
      subject: row.subject,
      body: row.body,
    })),
    ...inbox.map((row) => ({
      id: row.syntheticId || row.messageId,
      at: row.received,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      toEmail: '',
      subject: row.subject,
      body: row.body,
    })),
    ...outgoing,
  ];
  const briefProtocols: BriefProtocol[] = rows.flatMap((row) => {
    const meeting = meetingOfFile(row.source);
    const steps = stepsOf(row.steps);
    if (!steps.length) return [];
    return [{ id: row.id, at: meeting?.startsAt ?? row.createdAt.toISOString(), title: meeting?.title ?? '', steps }];
  });
  const storedTasks =
    tasks ??
    (await db.select().from(taskTable).where(eq(taskTable.leaderId, leaderId))).map((row) => ({
      id: row.externalId,
      title: row.title,
      owner: row.ownerName,
      dueOn: row.dueOn,
      status: row.status,
    }));
  return oneOnOneBrief(
    {
      leaderName,
      leaderEmail: leader?.email ?? '',
      leaderMailbox: mailConfig()?.user ?? '',
      origin: process.env.STAND_ORIGIN ?? '',
      until: `${day}T08:30`,
      people: staff.map((person) => ({ name: person.name, email: person.email })),
      meetings: meetings.map((meeting) => ({ ...meeting, kind: kindOf.get(meeting.summary) })),
      letters,
      protocols: briefProtocols,
      tasks: storedTasks.map((task) => ({ key: task.id, title: task.title, owner: task.owner, status: task.status })),
    },
    (packet) => judgeTurn(leaderId, packet),
  );
}

function sourcesFor(person: { name: string; email: string }, input: BriefInput, until: string): PacketSource[] {
  const sources: PacketSource[] = [];
  for (const protocol of input.protocols) {
    if (!stamp(protocol.at) || stamp(protocol.at) > until) continue;
    const about = personOfTitle(protocol.title, [person]) || protocol.steps.some((step) => mentioned(person.name, `${step.owner} ${step.task}`));
    if (!about) continue;
    const text = protocol.steps.map((step) => `${step.owner}: ${step.task}`).join('\n');
    sources.push({
      id: `p:${protocol.id}`,
      label: `Протокол ${dateWords(protocol.at)}`,
      href: href(input.origin, 'protocol', protocol.id),
      text,
    });
  }
  const letters = input.letters
    .filter((letter) => stamp(letter.at) && stamp(letter.at) <= until && aboutLetter(letter, person))
    .sort((a, b) => stamp(b.at).localeCompare(stamp(a.at)))
    .slice(0, LETTER_CAP)
    .reverse();
  for (const letter of letters) {
    sources.push({
      id: `m:${letter.id}`,
      label: `Письмо ${dateWords(letter.at)} «${letter.subject}»`,
      href: href(input.origin, 'letter', letter.id),
      text: `${letter.fromName}: ${letter.subject}. ${letter.body}`,
    });
  }
  for (const task of input.tasks) {
    if (CLOSED.has(task.status)) continue;
    const about = sameName(task.owner, person.name) || mentioned(person.name, task.title);
    if (!about) continue;
    sources.push({
      id: `t:${task.key}`,
      label: `Задача${task.key ? ` ${task.key}` : ''} «${task.title}»`,
      href: /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(task.key) ? `https://tracker.yandex.ru/${task.key}` : '',
      text: `${task.owner}: ${task.title}`,
    });
  }
  return sources;
}

function aboutLetter(letter: BriefLetter, person: { name: string; email: string }): boolean {
  if (sameName(letter.fromName, person.name)) return true;
  if (person.email && letter.toEmail.toLowerCase().includes(person.email.toLowerCase())) return true;
  if (person.email && letter.fromEmail.toLowerCase() === person.email.toLowerCase()) return true;
  return mentioned(person.name, `${letter.subject} ${letter.body}`);
}

function href(origin: string, kind: 'protocol' | 'letter', id: string): string {
  const base = origin.trim().replace(/\/+$/, '');
  return base && id ? `${base}/#${kind}-${encodeURIComponent(id)}` : '';
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 400 ? `${clean.slice(0, 399).trim()}…` : clean;
}

export function isPersonalMeeting(title: string, kind = ''): boolean {
  if (kind === 'один_на_один') return true;
  return /(?:^|[^a-zа-яё0-9])(?:1\s*[:\-]\s*1|один на один)(?![a-zа-яё])/i.test(title);
}

function personOfTitle(title: string, people: { name: string }[]): string | null {
  const hits = people.filter((person) => mentioned(person.name, title));
  return hits.length === 1 ? hits[0].name : null;
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
  if (match) return `${match[1]}-${match[2]}-${match[3]}T${match[4] ?? '00'}:${match[5] ?? '00'}`;
  const compact = /^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/.exec(value.trim());
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4] ?? '00'}:${compact[5] ?? '00'}`;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '';
  const moscow = new Date(parsed + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${moscow.getUTCFullYear()}-${pad(moscow.getUTCMonth() + 1)}-${pad(moscow.getUTCDate())}T${pad(moscow.getUTCHours())}:${pad(moscow.getUTCMinutes())}`;
}
