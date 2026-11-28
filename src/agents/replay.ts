// Пересчёт недели через правила. Код не знает людей и лимиты синтетики: они приходят в данных.
import { leaderMustConfirm, normalizeUnit, unitInText } from './confirm.ts';

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
  effect: 'стоп' | 'дайджест' | 'сам' | 'карточка';
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
  gluedLetters: number;
  gluedMeetings: number;
  remaining: string[];
}

export function ruleEffect(verdict: string, category: string, points: string[] = [], fromAudience = false): 'стоп' | 'карточка' | null {
  if (fromAudience || leaderMustConfirm(category, points)) return verdict === 'должно' ? null : 'карточка';
  if (verdict === 'должно' || verdict === '') return null;
  if (verdict === 'не_должно') return 'стоп';
  return 'карточка';
}

const STREAK = 5;

export function subjectKey(subject: string): string {
  return subject.replace(/^((re|fw|fwd|напоминание|повтор)\s*:\s*)+/i, '').trim().toLowerCase();
}

// Предел из утверждённых решений: наибольшее число с единицей в теме («Скидка 9%», «Сверхурочные 3 часа»).
export function limitFromApprovals(rows: HistoryRow[]): number | null {
  return limitWithUnit(rows)?.value ?? null;
}

export function limitWithUnit(rows: HistoryRow[]): { value: number; unit: string } | null {
  const found = rows
    .map((row) => {
      const match = /(\d+(?:[.,]\d+)?)\s*(%|ч\b|час[а-я]*|₽|руб[а-я]*)/i.exec(row.subject);
      if (!match) return null;
      const value = Number(match[1].replace(',', '.'));
      const raw = match[2].toLowerCase();
      const unit = raw === '%' ? '%' : raw.startsWith('ч') ? 'ч' : '₽';
      return Number.isFinite(value) ? { value, unit } : null;
    })
    .filter((item): item is { value: number; unit: string } => item !== null);
  if (!found.length) return null;
  const unit = found[0].unit;
  const same = found.filter((item) => item.unit === unit);
  return { value: Math.max(...same.map((item) => item.value)), unit };
}

// Право предлагается только с числовым пределом и только если он выше того, что у человека уже есть.
export function trustOffers(rows: HistoryRow[], current: { personId: string; area: string; limit: string }[] = []): TrustOffer[] {
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
    const found = limitWithUnit(streakRows);
    const sample = sorted[0];
    const have = current.find((row) => row.personId === sample.personId && row.area.toLowerCase() === sample.area.toLowerCase());
    const haveValue = have ? Number(have.limit.replace(',', '.')) : NaN;
    const above = found !== null && (!Number.isFinite(haveValue) || found.value > haveValue);
    const ready = streakRows.length >= STREAK && above;
    const limitText = found ? `до ${found.value}${found.unit === '%' ? '%' : ` ${found.unit}`}` : '';
    offers.push({
      personId: sample.personId,
      area: sample.area,
      limit: found?.value ?? null,
      streak: streakRows.length,
      ready,
      title: ready ? `Дать право решать самостоятельно «${sample.area}» ${limitText}: ${streakRows.length} утверждений подряд без правок` : '',
    });
  }
  return offers.filter((offer) => offer.ready);
}

export function rulesFromAudit(
  pieces: AuditPiece[],
  offers: TrustOffer[],
  emailByPerson: Map<string, string>,
  categoryByKey: Map<string, string> = new Map(),
  points: string[] = [],
  audienceEmails: Set<string> = new Set(),
  analyzedKeys?: Set<string>,
): FlowRule[] {
  const rules: FlowRule[] = [];
  for (const piece of pieces) {
    const split = piece.kind === 'письма' ? piece.key.indexOf('|') : -1;
    const fromEmail = split >= 0 ? piece.key.slice(0, split) : '';
    const subject = subjectKey(split >= 0 ? piece.key.slice(split + 1) : piece.title);
    const letterKey = `${fromEmail.toLowerCase()}|${subject}`;
    const category = piece.kind === 'письма' ? categoryByKey.get(letterKey) ?? '' : categoryByKey.get(`встреча|${subject}`) ?? '';
    const fromAudience = piece.kind === 'письма' && audienceEmails.has(fromEmail.toLowerCase());
    const unseen = piece.kind === 'письма' && analyzedKeys !== undefined && !analyzedKeys.has(letterKey);
    const effect = unseen
      ? piece.verdict === 'должно' || piece.verdict === ''
        ? null
        : 'карточка'
      : ruleEffect(piece.verdict, category, points, fromAudience);
    if (!effect) continue;
    if (piece.kind === 'письма') {
      rules.push({
        kind: 'письмо',
        title: piece.change || piece.title,
        personId: '',
        area: '',
        limitValue: '',
        fromEmail,
        subjectKey: subject,
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

export interface RightReading {
  area: string;
  value: number;
  unit: string;
  others: boolean;
}

// Принятое право покрывает разбор, а не текст письма. Без разбора не покрывает.
export function authorityCovers(rule: FlowRule, email: string, reading: RightReading | null | undefined): boolean {
  if (!reading || reading.others) return false;
  if (rule.kind !== 'полномочие' || rule.effect !== 'сам') return false;
  if (rule.fromEmail.toLowerCase() !== email.toLowerCase()) return false;
  if (!rule.area.trim() || rule.area.trim().toLowerCase() !== reading.area.trim().toLowerCase()) return false;
  const limit = Number(String(rule.limitValue).replace(/\s/g, '').replace(',', '.'));
  const unit = normalizeUnit(rule.limitValue) || unitInText(rule.title);
  if (!Number.isFinite(limit) || rule.limitValue === '' || !unit) return false;
  if (normalizeUnit(reading.unit) !== unit) return false;
  return Number.isFinite(reading.value) && reading.value <= limit;
}

export function readingOf(verdict: { area: string; value: string; unit: string; others: string } | null | undefined): RightReading | null {
  if (!verdict || verdict.others !== 'нет' || !verdict.area.trim()) return null;
  const value = Number(String(verdict.value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return { area: verdict.area, value, unit: verdict.unit, others: false };
}

export function readingForLetter(
  letterId: string,
  verdicts: { id: string; messageId: string; area: string; value: string; unit: string; others: string; at?: string }[],
  links: { syntheticId: string; messageId: string }[],
): RightReading | null {
  const messages = new Set([letterId, ...links.filter((link) => link.syntheticId === letterId).map((link) => link.messageId)]);
  const hits = verdicts.filter((verdict) => messages.has(verdict.messageId) || messages.has(verdict.id.replace(/^v-/, '')));
  const verdict = [...hits].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).at(-1);
  return readingOf(verdict);
}

export function letterHits(
  letter: { fromEmail: string; subject: string; body: string },
  rules: FlowRule[],
  reading?: RightReading | null,
): FlowRule | null {
  const email = letter.fromEmail.toLowerCase();
  const key = subjectKey(letter.subject);
  const thread = rules.find(
    (rule) =>
      rule.kind === 'письмо' &&
      rule.fromEmail.toLowerCase() === email &&
      rule.subjectKey === key &&
      (rule.effect === 'стоп' || rule.effect === 'дайджест' || rule.effect === 'карточка'),
  );
  const authority = rules.find((rule) => authorityCovers(rule, email, reading)) ?? null;
  if (authority && thread?.effect !== 'стоп' && thread?.effect !== 'дайджест') return authority;
  if (thread) return thread;
  return authority;
}

export function meetingHits(summary: string, rules: FlowRule[]): FlowRule | null {
  return rules.find((rule) => rule.kind === 'встреча' && rule.seriesKey === summary) ?? null;
}

export function replayWeek(
  letters: { fromEmail: string; subject: string; body: string; reading?: RightReading | null }[],
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
      gluedLetters: 0,
      gluedMeetings: 0,
      remaining: letters.map((letter) => letter.subject),
    };
  }
  let stoppedLetters = 0;
  let digestLetters = 0;
  let stillLetters = 0;
  let gluedLetters = 0;
  const seenLetters = new Set<string>();
  const remaining: string[] = [];
  for (const letter of letters) {
    const hit = letterHits(letter, rules, letter.reading);
    if (!hit) {
      stillLetters += 1;
      remaining.push(letter.subject);
    } else if (hit.effect === 'карточка') {
      const id = `${letter.fromEmail.toLowerCase()}|${subjectKey(letter.subject)}`;
      if (seenLetters.has(id)) gluedLetters += 1;
      else {
        seenLetters.add(id);
        stillLetters += 1;
        remaining.push(letter.subject);
      }
    } else if (hit.effect === 'дайджест') digestLetters += 1;
    else stoppedLetters += 1;
  }
  let stoppedMeetings = 0;
  let digestMeetings = 0;
  let stillMeetings = 0;
  let gluedMeetings = 0;
  const seenMeetings = new Set<string>();
  for (const meeting of meetings) {
    const hit = meetingHits(meeting.summary, rules);
    if (!hit) stillMeetings += 1;
    else if (hit.effect === 'карточка') {
      if (seenMeetings.has(meeting.summary)) gluedMeetings += 1;
      else {
        seenMeetings.add(meeting.summary);
        stillMeetings += 1;
        remaining.push(meeting.summary);
      }
    } else if (hit.effect === 'дайджест') digestMeetings += 1;
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
    gluedLetters,
    gluedMeetings,
    remaining,
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
