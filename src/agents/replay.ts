// Пересчёт недели через правила. Код не знает людей и лимиты синтетики: они приходят в данных.
import { textSignals } from './k2.ts';

export interface HistoryRow {
  personId: string;
  area: string;
  subject: string;
  outcome: string;
  at: string;
}

export interface TrustOffer {
  personId: string;
  area: string;
  limit: number | null;
  streak: number;
  ready: boolean;
  title: string;
}

export interface FlowRule {
  kind: 'письмо' | 'встреча' | 'полномочие';
  title: string;
  personId: string;
  area: string;
  limitValue: string;
  fromEmail: string;
  subjectKey: string;
  seriesKey: string;
  effect: 'стоп' | 'дайджест' | 'сам';
  cause: string;
}

export interface AuditPiece {
  kind: 'письма' | 'встречи';
  key: string;
  title: string;
  verdict: string;
  change: string;
  cause: string;
}

export interface Replay {
  before: number;
  after: number;
  letters: number;
  meetings: number;
  stoppedLetters: number;
  stoppedMeetings: number;
  digestLetters: number;
  digestMeetings: number;
  stillLetters: number;
  stillMeetings: number;
}

const STREAK = 5;

export function subjectKey(subject: string): string {
  return subject.replace(/^((re|fw|fwd|напоминание|повтор)\s*:\s*)+/i, '').trim().toLowerCase();
}

export function limitFromApprovals(rows: HistoryRow[]): number | null {
  const percents = rows
    .map((row) => {
      const match = /(\d+(?:[.,]\d+)?)\s*%/.exec(row.subject);
      return match ? Number(match[1].replace(',', '.')) : null;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (!percents.length) return null;
  return Math.max(...percents);
}

export function trustOffers(rows: HistoryRow[]): TrustOffer[] {
  const groups = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const key = `${row.personId}\t${row.area}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const offers: TrustOffer[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => b.at.localeCompare(a.at));
    const streakRows: HistoryRow[] = [];
    for (const row of sorted) {
      if (row.outcome !== 'утверждено') break;
      streakRows.push(row);
    }
    const limit = limitFromApprovals(streakRows);
    const ready = streakRows.length >= STREAK;
    const sample = sorted[0];
    const limitText = limit === null ? 'без числового предела в утверждённых решениях' : `до ${limit}%`;
    offers.push({
      personId: sample.personId,
      area: sample.area,
      limit,
      streak: streakRows.length,
      ready,
      title: ready ? `Отдать право самому решать «${sample.area}» ${limitText}: ${streakRows.length} утверждений подряд без правок` : '',
    });
  }
  return offers.filter((offer) => offer.ready);
}

export function rulesFromAudit(pieces: AuditPiece[], offers: TrustOffer[], emailByPerson: Map<string, string>): FlowRule[] {
  const rules: FlowRule[] = [];
  for (const piece of pieces) {
    if (piece.verdict === 'должно') continue;
    const effect = piece.verdict === 'не_должно' ? 'стоп' : 'дайджест';
    if (piece.kind === 'письма') {
      const split = piece.key.indexOf('|');
      rules.push({
        kind: 'письмо',
        title: piece.change || piece.title,
        personId: '',
        area: '',
        limitValue: '',
        fromEmail: split >= 0 ? piece.key.slice(0, split) : '',
        subjectKey: split >= 0 ? piece.key.slice(split + 1) : subjectKey(piece.title),
        seriesKey: '',
        effect,
        cause: piece.cause,
      });
    } else {
      rules.push({
        kind: 'встреча',
        title: piece.change || piece.title,
        personId: '',
        area: '',
        limitValue: '',
        fromEmail: '',
        subjectKey: '',
        seriesKey: piece.key,
        effect,
        cause: piece.cause,
      });
    }
  }
  for (const offer of offers) {
    const email = emailByPerson.get(offer.personId) ?? '';
    if (!email) continue;
    rules.push({
      kind: 'полномочие',
      title: offer.title,
      personId: offer.personId,
      area: offer.area,
      limitValue: offer.limit === null ? '' : String(offer.limit),
      fromEmail: email,
      subjectKey: '',
      seriesKey: '',
      effect: 'сам',
      cause: '',
    });
  }
  return rules;
}

export function letterHits(
  letter: { fromEmail: string; subject: string; body: string },
  rules: FlowRule[],
): FlowRule | null {
  const email = letter.fromEmail.toLowerCase();
  const key = subjectKey(letter.subject);
  const thread = rules.find(
    (rule) =>
      rule.kind === 'письмо' &&
      rule.fromEmail.toLowerCase() === email &&
      rule.subjectKey === key &&
      (rule.effect === 'стоп' || rule.effect === 'дайджест'),
  );
  if (thread) return thread;
  const signal = textSignals(`${letter.subject}\n${letter.body}`);
  if (signal.discountPercent === null) return null;
  return (
    rules.find((rule) => {
      if (rule.kind !== 'полномочие' || rule.effect !== 'сам') return false;
      if (rule.fromEmail.toLowerCase() !== email) return false;
      const limit = Number(rule.limitValue);
      return Number.isFinite(limit) && rule.limitValue !== '' && signal.discountPercent !== null && signal.discountPercent <= limit;
    }) ?? null
  );
}

export function meetingHits(summary: string, rules: FlowRule[]): FlowRule | null {
  return rules.find((rule) => rule.kind === 'встреча' && rule.seriesKey === summary) ?? null;
}

export function replayWeek(
  letters: { fromEmail: string; subject: string; body: string }[],
  meetings: { summary: string }[],
  rules: FlowRule[],
  accepted: boolean,
): Replay {
  const total = letters.length + meetings.length;
  const before = total === 0 ? 0 : 100;
  if (!accepted) {
    return {
      before,
      after: before,
      letters: letters.length,
      meetings: meetings.length,
      stoppedLetters: 0,
      stoppedMeetings: 0,
      digestLetters: 0,
      digestMeetings: 0,
      stillLetters: letters.length,
      stillMeetings: meetings.length,
    };
  }
  let stoppedLetters = 0;
  let digestLetters = 0;
  let stillLetters = 0;
  for (const letter of letters) {
    const hit = letterHits(letter, rules);
    if (!hit) stillLetters += 1;
    else if (hit.effect === 'дайджест') digestLetters += 1;
    else stoppedLetters += 1;
  }
  let stoppedMeetings = 0;
  let digestMeetings = 0;
  let stillMeetings = 0;
  for (const meeting of meetings) {
    const hit = meetingHits(meeting.summary, rules);
    if (!hit) stillMeetings += 1;
    else if (hit.effect === 'дайджест') digestMeetings += 1;
    else stoppedMeetings += 1;
  }
  const still = stillLetters + stillMeetings;
  return {
    before,
    after: total === 0 ? 0 : Math.round((100 * still) / total),
    letters: letters.length,
    meetings: meetings.length,
    stoppedLetters,
    stoppedMeetings,
    digestLetters,
    digestMeetings,
    stillLetters,
    stillMeetings,
  };
}

export function askShare(kinds: string[]): number {
  if (!kinds.length) return 0;
  const ask = kinds.filter((kind) => kind === 'нужен_руководитель').length;
  return Math.round((100 * ask) / kinds.length);
}

export function waitingHours(decisions: { status: string; createdAt: Date }[], now: Date): number {
  const ms = decisions
    .filter((row) => row.status === 'ждёт')
    .reduce((sum, row) => sum + Math.max(0, now.getTime() - row.createdAt.getTime()), 0);
  return Math.round((ms / 3_600_000) * 10) / 10;
}
