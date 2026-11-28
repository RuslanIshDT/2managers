// Журнал разбора почты. Числа и имена — только из переданных строк руководителя.
export const FEED_PAGE = 20;

const SENT_KINDS = new Set(['вернуть', 'делегировать']);

const KIND_ORDER = ['нужен_руководитель', 'вернуть', 'делегировать', 'в_сводку', 'игнорировать', 'авто', 'спросить_руководителя', 'повтор'];

export interface FeedVerdict {
  id: string;
  leaderId: string;
  messageId: string;
  chainKey: string;
  kind: string;
  category: string;
  summary: string;
  basis: string;
  createdAt: Date | string;
}

export interface FeedLetter {
  leaderId: string;
  messageId: string;
  syntheticId: string;
  received: string;
  fromName: string;
  subject: string;
}

export interface FeedCatalog {
  leaderId: string;
  externalId: string;
  received: string;
  fromName: string;
  subject: string;
}

export interface FeedDecision {
  id: string;
  leaderId: string;
  status: string;
  replyName: string;
  draft: string;
}

export interface FeedSource {
  verdicts: FeedVerdict[];
  inbox: FeedLetter[];
  catalog: FeedCatalog[];
  decisions: FeedDecision[];
}

export interface FeedInput {
  id: string;
  kind: string;
  category: string;
  summary: string;
  basis: string;
  at: string;
  chainKey: string;
  fromName: string;
  subject: string;
  sentTo: string;
  sentText: string;
}

export interface FeedReminder {
  at: string;
}

export interface FeedRow {
  id: string;
  kind: string;
  category: string;
  summary: string;
  basis: string;
  at: string;
  fromName: string;
  subject: string;
  sentTo: string;
  sentText: string;
  reminders: FeedReminder[];
}

export interface FeedCount {
  kind: string;
  n: number;
}

export function letterIdOf(verdictId: string): string {
  return verdictId.startsWith('v-') ? verdictId.slice(2) : verdictId;
}

export function reminderLabel(n: number): string {
  return `ещё ${countWords(n, 'напоминание', 'напоминания', 'напоминаний')}`;
}

export function prepareFeed(leaderId: string, source: FeedSource, hide: (text: string) => string): FeedInput[] {
  const inbox = source.inbox.filter((row) => row.leaderId === leaderId);
  const catalog = source.catalog.filter((row) => row.leaderId === leaderId);
  const done = new Map(
    source.decisions.filter((row) => row.leaderId === leaderId && row.status === 'исполнено').map((row) => [row.id, row]),
  );
  const byMessage = new Map(inbox.map((row) => [row.messageId, row]));
  const bySynthetic = new Map(inbox.filter((row) => row.syntheticId).map((row) => [row.syntheticId, row]));
  const byExternal = new Map(catalog.map((row) => [row.externalId, row]));
  return source.verdicts
    .filter((row) => row.leaderId === leaderId && row.kind !== 'не_из_отдела')
    .map((row) => {
      const fromVerdict = letterIdOf(row.id);
      const letter = byMessage.get(row.messageId) ?? bySynthetic.get(fromVerdict);
      const letterId = letter?.syntheticId || fromVerdict;
      const stored = byExternal.get(letterId);
      const decision = done.get(letterId);
      const sent = Boolean(decision && SENT_KINDS.has(row.kind));
      return {
        id: row.id,
        kind: row.kind,
        category: row.category,
        summary: hide(row.summary),
        basis: hide(row.basis),
        at: letter?.received || stored?.received || stamp(row.createdAt),
        chainKey: row.chainKey || row.id,
        fromName: hide(letter?.fromName || stored?.fromName || ''),
        subject: hide(letter?.subject || stored?.subject || ''),
        sentTo: sent && decision ? hide(decision.replyName) : '',
        sentText: sent && decision ? hide(decision.draft) : '',
      };
    });
}

export function assembleFeed(rows: FeedInput[], options: { offset?: number; limit?: number; kind?: string } = {}): { counts: FeedCount[]; items: FeedRow[]; more: boolean } {
  const limit = options.limit ?? FEED_PAGE;
  const offset = options.offset ?? 0;
  const counts = countKinds(rows);
  const kind = options.kind ?? '';
  const list = kind === 'повтор' ? repeatRows(rows) : collapse(rows).filter((row) => !kind || row.kind === kind);
  const items = list.slice(offset, offset + limit);
  return { counts, items, more: offset + items.length < list.length };
}

function repeatRows(rows: FeedInput[]): FeedRow[] {
  return rows
    .filter((row) => row.kind === 'повтор')
    .sort(newer)
    .map((row) => toRow(row, []));
}

function collapse(rows: FeedInput[]): FeedRow[] {
  const chains = new Map<string, FeedInput[]>();
  for (const row of rows) {
    const key = row.chainKey || row.id;
    const list = chains.get(key) ?? [];
    list.push(row);
    chains.set(key, list);
  }
  const groups: { row: FeedInput; reminders: FeedReminder[] }[] = [];
  for (const list of chains.values()) {
    const ordered = [...list].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    let current: { row: FeedInput; reminders: FeedReminder[] } | null = null;
    for (const row of ordered) {
      if (row.kind === 'повтор' && current) current.reminders.push({ at: row.at });
      else {
        current = { row, reminders: [] };
        groups.push(current);
      }
    }
  }
  return groups.sort((a, b) => newer(a.row, b.row)).map((group) => toRow(group.row, [...group.reminders].sort((a, b) => b.at.localeCompare(a.at))));
}

function toRow(row: FeedInput, reminders: FeedReminder[]): FeedRow {
  return {
    id: row.id,
    kind: row.kind,
    category: row.category,
    summary: row.summary,
    basis: row.basis,
    at: row.at,
    fromName: row.fromName,
    subject: row.subject,
    sentTo: row.sentTo,
    sentText: row.sentText,
    reminders,
  };
}

function newer(a: FeedInput, b: FeedInput): number {
  return b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
}

function countKinds(rows: FeedInput[]): FeedCount[] {
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.kind, (map.get(row.kind) ?? 0) + 1);
  return [...map.entries()]
    .map(([kind, n]) => ({ kind, n }))
    .sort((a, b) => {
      const left = KIND_ORDER.indexOf(a.kind);
      const right = KIND_ORDER.indexOf(b.kind);
      const orderA = left === -1 ? KIND_ORDER.length : left;
      const orderB = right === -1 ? KIND_ORDER.length : right;
      return orderA - orderB || b.n - a.n || a.kind.localeCompare(b.kind);
    });
}

function stamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function countWords(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const tail = abs % 10;
  const hundred = abs % 100;
  const word = tail === 1 && hundred !== 11 ? one : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? few : many;
  return `${n} ${word}`;
}
