// Перед встречей один на один модель решает, ждёт ли сотрудник действия руководителя.
// Код только собирает источники и проверяет, что названные в ответе записи есть в собранном списке.
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { emails, mailIn, people, protocols, seriesKind, tasks as taskTable } from '../db/schema.ts';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';
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
  closedAt?: string;
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

export type SourceRole = 'письмо_сотрудника' | 'письмо_руководителя' | 'протокол' | 'задача' | 'задача_закрыта';

export const CLOSE_REASONS = ['сотрудник ещё не передал свою часть', 'руководитель решил', 'задача закрыта'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number] | '';

export interface PacketSource {
  id: string;
  at: string;
  role: SourceRole;
  label: string;
  href: string;
  text: string;
}

export interface MeetingPacket {
  name: string;
  leaderName: string;
  summary: string;
  sources: PacketSource[];
}

export interface TurnVerdict {
  waiting: boolean;
  action: string;
  sourceIds: string[];
  reason: CloseReason;
}

const CLOSED = new Set(['сделана', 'закрыта', 'отменена', 'готово']);
const LETTER_CAP = 12;

const reasonChoices = ['', ...CLOSE_REASONS] as [CloseReason, ...CloseReason[]];

const verdictZod = z.object({
  ждёт: z.boolean(),
  действие: z.string().max(300),
  почему: z.enum(reasonChoices),
  источники: z.array(z.string().max(120)).max(8),
});

const verdictSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ждёт', 'действие', 'почему', 'источники'],
  properties: {
    ждёт: { type: 'boolean' },
    действие: { type: 'string' },
    почему: { type: 'string', enum: reasonChoices },
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
    packets.push({
      name: person.name,
      leaderName: input.leaderName,
      summary: meeting.summary,
      sources: sourcesFor(person, input, until),
    });
  }
  return packets;
}

function lastEmployeeLetter(packet: MeetingPacket): PacketSource | undefined {
  return packet.sources.filter((source) => source.role === 'письмо_сотрудника').sort((a, b) => a.at.localeCompare(b.at)).at(-1);
}

function notBefore(at: string, last: string | undefined): boolean {
  if (!last) return true;
  if (!at) return false;
  return at >= last;
}

function citedSources(packet: MeetingPacket, ids: string[]): PacketSource[] {
  return ids.flatMap((id) => {
    const source = sourceById(packet, id);
    return source ? [source] : [];
  });
}

function shownSources(packet: MeetingPacket, ids: string[]): PacketSource[] {
  const named = citedSources(packet, ids);
  if (named.length) return named;
  const letter = lastEmployeeLetter(packet);
  if (letter) return [letter];
  const protocol = packet.sources.find((source) => source.role === 'протокол');
  return protocol ? [protocol] : [];
}

function sourceTitle(source: PacketSource): string {
  return /«([^»]*)»/.exec(source.label)?.[1] ?? source.label;
}

function uncheckedText(packet: MeetingPacket): string {
  const letter = lastEmployeeLetter(packet) ?? packet.sources.find((source) => source.role === 'протокол');
  const title = letter ? sourceTitle(letter) : 'источник';
  return `Помощник не смог проверить, посмотрите письмо «${title}».`;
}

export function blocksFromVerdicts(packets: MeetingPacket[], verdicts: TurnVerdict[]): OneOnOneBlock[] {
  return packets.flatMap((packet, index) => {
    if (!packet.sources.length) return [];
    const verdict = verdicts[index] ?? { waiting: false, action: '', sourceIds: [], reason: '' as const };
    if (!verdict.waiting && closureHolds(packet, verdict)) return [];
    const sources = shownSources(packet, verdict.sourceIds);
    if (!sources.length) return [];
    const text = verdict.action.trim() || uncheckedText(packet);
    return [{ name: packet.name, lines: [{ text, sources: sources.map((source) => ({ label: source.label, href: source.href })) }] }];
  });
}

// Строка снимается, только если названный источник есть и он подтверждает причину.
// Иначе модель могла закрыть вопрос ответом без решения — строка остаётся.
function sourceById(packet: MeetingPacket, id: string): PacketSource | undefined {
  const exact = packet.sources.find((source) => source.id === id);
  if (exact) return exact;
  const matches = packet.sources.filter((source) => source.id.endsWith(`:${id}`));
  return matches.length === 1 ? matches[0] : undefined;
}

function closureHolds(packet: MeetingPacket, verdict: TurnVerdict): boolean {
  const sources = citedSources(packet, verdict.sourceIds);
  const last = lastEmployeeLetter(packet)?.at;
  if (verdict.reason === 'сотрудник ещё не передал свою часть') {
    const letter = lastEmployeeLetter(packet);
    if (!letter) return sources.length > 0;
    return sources.some((source) => source.id === letter.id);
  }
  if (verdict.reason === 'руководитель решил') {
    return sources.some((source) => (source.role === 'письмо_руководителя' || source.role === 'протокол') && notBefore(source.at, last));
  }
  if (verdict.reason === 'задача закрыта') {
    return sources.some((source) => source.role === 'задача_закрыта' && notBefore(source.at, last));
  }
  return false;
}

export async function judgeTurn(leaderId: string, packet: MeetingPacket): Promise<TurnVerdict> {
  const list = packet.sources.map((source) => `${source.id} | ${source.at} | ${source.label} | ${clip(source.text)}`).join('\n');
  const result = await callJson<unknown>({
    purpose: `one-on-one:${leaderId}:${packet.name}`,
    system: [
      'Ты решаешь по источникам, ждёт ли сотрудник к встрече один на один действия руководителя.',
      'Руководитель и сотрудник названы во входе. Не путай их.',
      'Ждёт, если свою часть сотрудник уже передал и ход за руководителем.',
      'Своя часть передана, когда в письме сотрудника уже есть варианты, материалы, файл или ссылка. Обещание прислать позже — ещё не передано. Назначенный созвон в том же письме передачу не отменяет.',
      'Вопрос закрыт, только если руководитель решил по существу: выбрал, утвердил или отказал, — или задача закрыта и после её закрытия сотрудник ничего нового не прислал.',
      'Ответ без решения вопрос не закрывает: благодарность и обещание посмотреть — не выбор и не отказ.',
      'Протокол закрывает вопрос, только если в нём записан выбор, утверждение или отказ. Поручение разобраться вопрос не закрывает.',
      'Не ждёт, если сотрудник ещё не передал свою часть, руководитель решил или задача закрыта и нового письма после закрытия нет.',
      'действие — одно короткое предложение, какого действия ждут от руководителя. Заполни и когда ждёт, и когда не ждёт.',
      'почему — пусто, если ждёт. Иначе одна из трёх причин.',
      'источники — id записей, на которых основан ответ. Только id из списка. Если причина «сотрудник ещё не передал свою часть», назови его последнее письмо; если писем сотрудника нет — любой источник из списка.',
    ].join(' '),
    user: `Руководитель: ${packet.leaderName}. Сотрудник: ${packet.name}. Встреча: ${packet.summary}.\n${list || 'Источников нет.'}`,
    schemaName: 'one_on_one',
    schema: verdictSchema,
  });
  const parsed = verdictZod.safeParse(result.data);
  if (!parsed.success) return { waiting: false, action: '', sourceIds: [], reason: '' };
  return {
    waiting: parsed.data.ждёт,
    action: parsed.data.действие.trim(),
    sourceIds: parsed.data.источники,
    reason: parsed.data.ждёт ? '' : parsed.data.почему,
  };
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
      verdicts.push({ waiting: false, action: '', sourceIds: [], reason: '' });
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
  const storedTasks = tasks
    ? tasks.map((task) => ({ ...task, closedAt: task.closedAt ?? '' }))
    : (await db.select().from(taskTable).where(eq(taskTable.leaderId, leaderId))).map((row) => ({
        id: row.externalId,
        title: row.title,
        owner: row.ownerName,
        dueOn: row.dueOn,
        status: row.status,
        closedAt: '',
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
      tasks: storedTasks.map((task) => ({ key: task.id, title: task.title, owner: task.owner, status: task.status, closedAt: task.closedAt })),
    },
    (packet) =>
      withLlmScope(
        { agent: 'one-on-one', leaderId, operationId: `one-on-one:${leaderId}:${day}:${packet.name}`, title: `К встрече: ${packet.name}` },
        () => judgeTurn(leaderId, packet),
      ),
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
      at: stamp(protocol.at),
      role: 'протокол',
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
    const leader = fromLeader(letter, input);
    sources.push({
      id: `m:${letter.id}`,
      at: stamp(letter.at),
      role: leader ? 'письмо_руководителя' : 'письмо_сотрудника',
      label: `Письмо ${dateWords(letter.at)} «${letter.subject}»`,
      href: href(input.origin, 'letter', letter.id),
      text: `От: ${letter.fromName}. Кому: ${letter.toEmail || 'не указано'}. ${letter.subject}. ${letter.body}`,
    });
  }
  const floor = earliest(sources.map((source) => source.at));
  for (const task of input.tasks) {
    const about = sameName(task.owner, person.name) || mentioned(person.name, task.title);
    if (!about) continue;
    const closed = CLOSED.has(task.status.trim().toLowerCase());
    const at = stamp(task.closedAt ?? '');
    if (closed && floor && at && at < floor) continue;
    sources.push({
      id: `t:${task.key}`,
      at,
      role: closed ? 'задача_закрыта' : 'задача',
      label: `Задача${task.key ? ` ${task.key}` : ''} «${task.title}»`,
      href: /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(task.key) ? `https://tracker.yandex.ru/${task.key}` : '',
      text: `Исполнитель: ${task.owner}. Статус: ${task.status}. Закрыта: ${task.closedAt ? dateWords(task.closedAt) : 'даты нет'}. ${task.title}`,
    });
  }
  return sources;
}

function fromLeader(letter: BriefLetter, input: BriefInput): boolean {
  const email = letter.fromEmail.trim().toLowerCase();
  if (input.leaderEmail && email === input.leaderEmail.trim().toLowerCase()) return true;
  if (input.leaderMailbox && email === input.leaderMailbox.trim().toLowerCase()) return true;
  return sameName(letter.fromName, input.leaderName);
}

function earliest(dates: string[]): string {
  return dates.filter(Boolean).sort()[0] ?? '';
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
