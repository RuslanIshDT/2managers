// Список правил недели для раздела «Поток». Имена, темы и числа приходят из данных руководителя.
import { CAUSES, type Cause } from './flow-audit.ts';
import { letterHits, meetingHits, replayWeek, subjectKey, type FlowRule, type RightReading, type TrustOffer } from './replay.ts';

export interface FlowPerson {
  id: string;
  name: string;
  emails: string[];
}

export interface FlowLetter {
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  reading?: RightReading | null;
}

export interface FlowMeeting {
  summary: string;
  minutes: number;
}

export interface FlowRuleRow {
  who: string;
  subject: string;
  amount: string;
  cause: string;
  change: string;
  area: string;
  limit: string;
  basis: string;
}

export interface FlowRuleView {
  summary: string;
  lettersAway: number;
  meetingsAway: number;
  chains: FlowRuleRow[];
  series: FlowRuleRow[];
  rights: FlowRuleRow[];
}

export function flowRuleList(input: {
  rules: FlowRule[];
  letters: FlowLetter[];
  meetings: FlowMeeting[];
  people: FlowPerson[];
  offers?: TrustOffer[];
}): FlowRuleView {
  const rules = input.rules.filter(shownRule);
  const picture = replayWeek(input.letters, input.meetings, rules, rules.length > 0);
  const lettersAway = picture.stoppedLetters + picture.digestLetters;
  const meetingsAway = picture.stoppedMeetings + picture.digestMeetings;
  return {
    summary: awaySummary(lettersAway, meetingsAway),
    lettersAway,
    meetingsAway,
    chains: rules.filter((rule) => rule.kind === 'письмо').map((rule) => chainRow(rule, input)),
    series: rules.filter((rule) => rule.kind === 'встреча').map((rule) => seriesRow(rule, input)),
    rights: rules.filter((rule) => rule.kind === 'полномочие').map((rule) => rightRow(rule, input)),
  };
}

export function acceptedLine(iso: string): string {
  const words = moscowDate(iso);
  return words ? `приняты ${words}` : '';
}

export function awaySummary(letters: number, meetings: number): string {
  const parts: string[] = [];
  if (letters > 0) parts.push(countWords(letters, 'письмо', 'письма', 'писем'));
  if (meetings > 0) parts.push(countWords(meetings, 'встреча', 'встречи', 'встреч'));
  if (!parts.length) return '';
  const named = parts.length === 2 ? `${parts[0]} и ${parts[1]}` : parts[0];
  const alone = parts.length === 1 ? (letters > 0 ? letters : meetings) : 0;
  const verb = parts.length === 1 && singular(alone) ? 'дойдёт' : 'дойдут';
  return `До вас не ${verb} ${named}`;
}

function shownRule(rule: FlowRule): boolean {
  if (rule.kind === 'полномочие') return true;
  return rule.effect === 'стоп' || rule.effect === 'дайджест' || rule.effect === 'карточка';
}

function chainRow(rule: FlowRule, input: { rules: FlowRule[]; letters: FlowLetter[]; people: FlowPerson[] }): FlowRuleRow {
  const matched = input.letters.filter((letter) => sameRule(letterHits(letter, input.rules, letter.reading), rule));
  const sample = matched.find((letter) => letter.fromName.trim()) ?? matched[0];
  return {
    who: sample?.fromName.trim() || personName(rule, input.people),
    subject: subjectWords(rule, matched),
    amount: `${countWords(matched.length, 'письмо', 'письма', 'писем')} за неделю`,
    cause: causeWords(rule.cause),
    change: changeWords(rule.effect),
    area: '',
    limit: '',
    basis: '',
  };
}

function seriesRow(rule: FlowRule, input: { rules: FlowRule[]; meetings: FlowMeeting[] }): FlowRuleRow {
  const matched = input.meetings.filter((meeting) => sameRule(meetingHits(meeting.summary, input.rules), rule));
  const minutes = matched.reduce((sum, meeting) => sum + (meeting.minutes > 0 ? meeting.minutes : 0), 0);
  const meetings = countWords(matched.length, 'встреча', 'встречи', 'встреч');
  return {
    who: '',
    subject: rule.seriesKey.trim() || rule.title.trim(),
    amount: minutes > 0 ? `${meetings}, ${countWords(minutes, 'минута', 'минуты', 'минут')}` : meetings,
    cause: causeWords(rule.cause),
    change: changeWords(rule.effect),
    area: '',
    limit: '',
    basis: '',
  };
}

function rightRow(rule: FlowRule, input: { people: FlowPerson[]; offers?: TrustOffer[] }): FlowRuleRow {
  const offer = input.offers?.find((item) => item.personId === rule.personId && item.area.trim().toLowerCase() === rule.area.trim().toLowerCase());
  return {
    who: personName(rule, input.people),
    subject: '',
    amount: '',
    cause: '',
    change: '',
    area: rule.area.trim(),
    limit: limitWords(rule),
    basis: streakWords(rule, offer),
  };
}

function sameRule(hit: FlowRule | null, rule: FlowRule): boolean {
  if (!hit || hit.kind !== rule.kind) return false;
  if (rule.kind === 'письмо') return hit.fromEmail.toLowerCase() === rule.fromEmail.toLowerCase() && hit.subjectKey === rule.subjectKey;
  if (rule.kind === 'встреча') return hit.seriesKey === rule.seriesKey;
  return hit.personId === rule.personId && hit.area.trim().toLowerCase() === rule.area.trim().toLowerCase();
}

function subjectWords(rule: FlowRule, letters: FlowLetter[]): string {
  const clean = (subject: string) => subject.replace(/^((re|fw|fwd|напоминание|повтор)\s*:\s*)+/i, '').trim();
  const picked = letters.map((letter) => clean(letter.subject)).find((subject) => subject.length > 0);
  return picked || rule.subjectKey.trim();
}

function personName(rule: FlowRule, people: FlowPerson[]): string {
  const byId = people.find((person) => person.id === rule.personId && person.name.trim());
  if (byId) return byId.name.trim();
  const email = rule.fromEmail.trim().toLowerCase();
  const byEmail = people.find((person) => person.emails.some((item) => item.trim().toLowerCase() === email) && person.name.trim());
  return byEmail?.name.trim() ?? '';
}

function causeWords(cause: string): string {
  const known = CAUSES[cause as Cause];
  if (known) return known.label;
  const text = cause.trim();
  if (!text || text === 'нужно') return '';
  if (text.includes('_') && !text.includes(' ')) return text.replaceAll('_', ' ');
  return text;
}

function changeWords(effect: FlowRule['effect']): string {
  if (effect === 'карточка') return 'приходит один раз карточкой';
  if (effect === 'стоп' || effect === 'дайджест') return 'до вас не доходит';
  return '';
}

function limitWords(rule: FlowRule): string {
  const match = /до\s+\d+(?:[.,]\d+)?(?:\s*(?:%|ч|₽))?/.exec(rule.title);
  if (match) return match[0].replace(/\s+/g, ' ').trim();
  return rule.limitValue.trim() ? `до ${rule.limitValue.trim()}` : '';
}

function streakWords(rule: FlowRule, offer: TrustOffer | undefined): string {
  const fromTitle = /(\d+)\s+утверждени/.exec(rule.title);
  const streak = offer && offer.streak > 0 ? offer.streak : fromTitle ? Number(fromTitle[1]) : 0;
  if (!Number.isFinite(streak) || streak <= 0) return '';
  return `${countWords(streak, 'утверждение', 'утверждения', 'утверждений')} подряд`;
}

function moscowDate(iso: string): string {
  const date = new Date(iso);
  if (!iso.trim() || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const day = Number(parts.find((part) => part.type === 'day')?.value ?? '');
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? '');
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  if (!day || !months[month - 1]) return '';
  return `${day} ${months[month - 1]}`;
}

function singular(n: number): boolean {
  const abs = Math.abs(n);
  return abs % 10 === 1 && abs % 100 !== 11;
}

function countWords(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const tail = abs % 10;
  const hundred = abs % 100;
  const word = tail === 1 && hundred !== 11 ? one : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? few : many;
  return `${n} ${word}`;
}
