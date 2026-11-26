// K10–K13. Индекс, порог доверия и карточка считаются кодом. Модель не вызывается.
import { readFile } from 'node:fs/promises';
import { textSignals } from './k2.ts';
import { parseCsv } from '../data/synthetic.ts';

export const TRUST_STREAK = 5;
export const OLGA_DISCOUNT_LIMIT = 10;

export interface HistoryRow {
  personId: string;
  area: string;
  subject: string;
  outcome: string;
  at: string;
}

export interface AuditTotals {
  flowHours: number;
  freedHours: number;
  letters: number;
  meetings: number;
  stoppedLetters: number;
  stoppedMeetings: number;
  digestLetters: number;
  digestMeetings: number;
}

export interface Dependence {
  before: number;
  after: number;
  flowHours: number;
  stillHours: number;
  stoppedLetters: number;
  stoppedMeetings: number;
  digestLetters: number;
  digestMeetings: number;
}

export interface TrustOffer {
  personId: string;
  area: string;
  limit: number;
  streak: number;
  ready: boolean;
  title: string;
}

export interface StaffCard {
  вывод: string;
  рекомендация: string;
  основание: string;
  риски: string;
  если_не_решить: string;
  контекст: string;
}

export interface AuthorityRule {
  personId: string;
  email: string;
  area: string;
  limit: number;
}

export function dependenceIndex(flowHours: number, stillHours: number): number {
  if (flowHours <= 0) return 0;
  return Math.round((100 * stillHours) / flowHours);
}

export function dependenceOf(audit: AuditTotals, accepted: boolean): Dependence {
  const still = accepted ? Math.max(0, audit.flowHours - audit.freedHours) : audit.flowHours;
  return {
    before: dependenceIndex(audit.flowHours, audit.flowHours),
    after: dependenceIndex(audit.flowHours, Math.max(0, audit.flowHours - audit.freedHours)),
    flowHours: round1(audit.flowHours),
    stillHours: round1(still),
    stoppedLetters: accepted ? audit.stoppedLetters : 0,
    stoppedMeetings: accepted ? audit.stoppedMeetings : 0,
    digestLetters: accepted ? audit.digestLetters : 0,
    digestMeetings: accepted ? audit.digestMeetings : 0,
  };
}

export function trustOffer(rows: HistoryRow[], personId: string, area: string, limit = OLGA_DISCOUNT_LIMIT): TrustOffer {
  const mine = rows
    .filter((row) => row.personId === personId && row.area === area)
    .sort((a, b) => b.at.localeCompare(a.at));
  let streak = 0;
  for (const row of mine) {
    if (row.outcome !== 'утверждено') break;
    streak += 1;
  }
  const ready = streak >= TRUST_STREAK;
  return {
    personId,
    area,
    limit,
    streak,
    ready,
    title: ready
      ? `Отдать право самой решать «${area}» до ${limit}%: ${streak} утверждений подряд без правок`
      : '',
  };
}

export function authorityBlocks(
  letter: { fromEmail: string; subject: string; body: string },
  rules: AuthorityRule[],
): AuthorityRule | null {
  const signal = textSignals(`${letter.subject}\n${letter.body}`);
  if (signal.discountPercent === null) return null;
  const email = letter.fromEmail.toLowerCase();
  return (
    rules.find(
      (rule) =>
        rule.email.toLowerCase() === email &&
        rule.area.toLowerCase().includes('скид') &&
        signal.discountPercent !== null &&
        signal.discountPercent <= rule.limit,
    ) ?? null
  );
}

export function staffCard(input: StaffCard): StaffCard | null {
  if (!input.вывод.trim() || !input.рекомендация.trim()) return null;
  return input;
}

export function staffFromVerdict(input: {
  summary: string;
  recommendation: string;
  basis: string;
  context: string;
  risks: string;
  ifNot: string;
}): StaffCard | null {
  return staffCard({
    вывод: input.summary.trim(),
    рекомендация: input.recommendation.trim() || 'Решение за вами: утвердить черновик или отклонить.',
    основание: input.basis.trim() || 'Основание собрано из полномочий и письма.',
    риски: input.risks.trim(),
    если_не_решить: input.ifNot.trim(),
    контекст: input.context.trim() || 'Контекст — карточка подчинённого и текст письма.',
  });
}

export async function readHistory(dir = 'data/synthetic'): Promise<HistoryRow[]> {
  const raw = await readFile(`${dir}/decisions_history.csv`, 'utf8');
  const text = raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n');
  return parseCsv(text).map((row) => ({
    personId: row.person_id,
    area: row.area,
    subject: row.subject,
    outcome: row.outcome,
    at: row.at,
  }));
}

export async function readAuditTotals(path = 'reports/flow-audit.json'): Promise<AuditTotals> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    summary?: {
      flowHours?: number;
      freedHours?: number;
      letters?: number;
      meetings?: number;
      byVerdict?: { verdict?: string; letters?: number; meetings?: number }[];
    };
  };
  const summary = raw.summary;
  if (!summary || typeof summary.flowHours !== 'number' || typeof summary.freedHours !== 'number') {
    throw new Error('В отчёте аудита нет сводки часов');
  }
  const by = (verdict: string) => summary.byVerdict?.find((row) => row.verdict === verdict);
  const gone = by('не_должно');
  const other = by('в_другом_виде');
  return {
    flowHours: summary.flowHours,
    freedHours: summary.freedHours,
    letters: summary.letters ?? 0,
    meetings: summary.meetings ?? 0,
    stoppedLetters: gone?.letters ?? 0,
    stoppedMeetings: gone?.meetings ?? 0,
    digestLetters: other?.letters ?? 0,
    digestMeetings: other?.meetings ?? 0,
  };
}

export async function readAuditChanges(path = 'reports/flow-audit.json'): Promise<{ cause: string; title: string }[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    summary?: { byChange?: { cause?: string; change?: string }[] };
  };
  return (raw.summary?.byChange ?? [])
    .filter((row) => row.cause && row.change)
    .map((row) => ({ cause: row.cause as string, title: row.change as string }));
}
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
