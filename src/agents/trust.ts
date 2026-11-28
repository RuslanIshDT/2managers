// Журнал доверия: история из файла плюс решения руководителя на стенде, по времени.
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, emails, leaderActs, mailIn, people, verdicts } from '../db/schema.ts';
import { formatAmount, normalizeUnit } from './confirm.ts';
import { readHistory, type HistoryRow } from './dependence.ts';
import { personAddresses } from './k1.ts';

export function decisionOutcome(status: string, original: string, approved: string): 'утверждено' | 'с правкой' | 'отклонено' | null {
  if (status === 'отклонено') return 'отклонено';
  if (status !== 'исполнено') return null;
  const before = original.trim();
  const after = approved.trim();
  if (before && after && before !== after) return 'с правкой';
  return 'утверждено';
}

export function trustSubject(subject: string, value: number, unit: string): string {
  const mark = unit === '%' ? '%' : ` ${unit}`;
  return `${subject} ${formatAmount(value)}${mark}`.trim();
}

const LEADER_BUTTONS = new Set(['утвердил', 'отклонил']);

export function standTrustRows(input: {
  decisions: { id: string; status: string; subject: string; summary: string; draft: string; originalDraft: string; replyName: string; replyTo: string; createdAt: Date }[];
  acts: { refId: string; auto: boolean; action: string }[];
  verdicts?: { id: string; area: string; value: string; unit: string }[];
  letters: { fromEmail: string; subject: string; body: string }[];
  people: { id: string; name: string; email: string; extraEmail?: string }[];
  authorities: { personId: string; area: string; unit: string }[];
}): HistoryRow[] {
  const pressed = new Set(
    input.acts.filter((act) => !act.auto && LEADER_BUTTONS.has(act.action)).map((act) => act.refId),
  );
  const rows: HistoryRow[] = [];
  for (const decision of input.decisions) {
    if (!pressed.has(decision.id)) continue;
    const outcome = decisionOutcome(decision.status, decision.originalDraft, decision.draft);
    if (!outcome) continue;
    const person = input.people.find(
      (row) =>
        personAddresses(row).includes(decision.replyTo.trim().toLowerCase()) ||
        row.name.trim().toLowerCase() === decision.replyName.trim().toLowerCase(),
    );
    if (!person) continue;
    const verdict = (input.verdicts ?? []).find((row) => row.id === `v-${decision.id}`);
    const value = Number(String(verdict?.value ?? '').replace(',', '.'));
    const unit = normalizeUnit(verdict?.unit ?? '');
    const power = input.authorities.find((row) => row.personId === person.id && row.area.trim().toLowerCase() === (verdict?.area ?? '').trim().toLowerCase());
    if (!verdict?.area || !power || !unit || !Number.isFinite(value)) continue;
    rows.push({
      personId: person.id,
      area: power.area,
      subject: trustSubject(decision.subject, value, unit),
      outcome,
      at: decision.createdAt.toISOString(),
    });
  }
  return rows;
}

export async function historyForLeader(db: Db, leaderId: string): Promise<HistoryRow[]> {
  let file: HistoryRow[] = [];
  try {
    file = await readHistory(`data/${leaderId}`);
  } catch {
    file = [];
  }
  const [decisionRows, actRows, verdictRows, personRows, authRows, catalog, inbox] = await Promise.all([
    db.select().from(decisions).where(and(eq(decisions.leaderId, leaderId), inArray(decisions.status, ['исполнено', 'отклонено']))),
    db.select({ refId: leaderActs.refId, auto: leaderActs.auto, action: leaderActs.action }).from(leaderActs).where(eq(leaderActs.leaderId, leaderId)),
    db.select({ id: verdicts.id, area: verdicts.authorityArea, value: verdicts.authorityValue, unit: verdicts.authorityUnit }).from(verdicts).where(eq(verdicts.leaderId, leaderId)),
    db.select().from(people).where(eq(people.leaderId, leaderId)),
    db.select().from(authorities).where(eq(authorities.leaderId, leaderId)),
    db.select({ fromEmail: emails.fromEmail, subject: emails.subject, body: emails.body }).from(emails).where(eq(emails.leaderId, leaderId)),
    db.select({ fromEmail: mailIn.fromEmail, subject: mailIn.subject, body: mailIn.body }).from(mailIn).where(eq(mailIn.leaderId, leaderId)),
  ]);
  const stand = standTrustRows({
    decisions: decisionRows,
    acts: actRows,
    verdicts: verdictRows,
    letters: [...catalog, ...inbox],
    people: personRows.map((row) => ({ id: row.externalId, name: row.name, email: row.email, extraEmail: row.extraEmail })),
    authorities: authRows.map((row) => ({ personId: row.personId, area: row.area, unit: row.unit })),
  });
  return [...file, ...stand].sort((a, b) => a.at.localeCompare(b.at));
}
