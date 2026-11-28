// Журнал доверия: история из файла плюс решения руководителя на стенде, по времени.
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, emails, leaderActs, mailIn, people } from '../db/schema.ts';
import { formatAmount, nearestAmount, normalizeUnit } from './confirm.ts';
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

function areaNamed(text: string, area: string, unit: string): boolean {
  return nearestAmount(text, area, unit) !== null || text.toLowerCase().includes(area.trim().toLowerCase());
}

export function trustSubject(subject: string, text: string, area: string, unit: string): string {
  if (nearestAmount(subject, area, unit) !== null) return subject;
  const value = nearestAmount(`${subject}\n${text}`, area, unit);
  if (value === null) return subject;
  const mark = unit === '%' ? '%' : ` ${unit}`;
  return `${subject} ${formatAmount(value)}${mark}`.trim();
}

const LEADER_BUTTONS = new Set(['утвердил', 'отклонил']);

export function standTrustRows(input: {
  decisions: { id: string; status: string; subject: string; summary: string; draft: string; originalDraft: string; replyName: string; replyTo: string; createdAt: Date }[];
  acts: { refId: string; auto: boolean; action: string }[];
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
    const letter = input.letters.find((row) => row.subject === decision.subject && row.fromEmail.toLowerCase() === decision.replyTo.trim().toLowerCase());
    const text = `${decision.subject}\n${letter?.body ?? ''}\n${decision.summary}\n${decision.draft}`;
    const powers = input.authorities.filter((row) => row.personId === person.id);
    const named = powers.filter((row) => areaNamed(text, row.area, normalizeUnit(row.unit) || '%'));
    const withNumber = named.find((row) => nearestAmount(text, row.area, normalizeUnit(row.unit)) !== null) ?? named[0];
    if (!withNumber) continue;
    const unit = normalizeUnit(withNumber.unit);
    rows.push({
      personId: person.id,
      area: withNumber.area,
      subject: unit ? trustSubject(decision.subject, text, withNumber.area, unit) : decision.subject,
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
  const [decisionRows, actRows, personRows, authRows, catalog, inbox] = await Promise.all([
    db.select().from(decisions).where(and(eq(decisions.leaderId, leaderId), inArray(decisions.status, ['исполнено', 'отклонено']))),
    db.select({ refId: leaderActs.refId, auto: leaderActs.auto, action: leaderActs.action }).from(leaderActs).where(eq(leaderActs.leaderId, leaderId)),
    db.select().from(people).where(eq(people.leaderId, leaderId)),
    db.select().from(authorities).where(eq(authorities.leaderId, leaderId)),
    db.select({ fromEmail: emails.fromEmail, subject: emails.subject, body: emails.body }).from(emails).where(eq(emails.leaderId, leaderId)),
    db.select({ fromEmail: mailIn.fromEmail, subject: mailIn.subject, body: mailIn.body }).from(mailIn).where(eq(mailIn.leaderId, leaderId)),
  ]);
  const stand = standTrustRows({
    decisions: decisionRows,
    acts: actRows,
    letters: [...catalog, ...inbox],
    people: personRows.map((row) => ({ id: row.externalId, name: row.name, email: row.email, extraEmail: row.extraEmail })),
    authorities: authRows.map((row) => ({ personId: row.personId, area: row.area, unit: row.unit })),
  });
  return [...file, ...stand].sort((a, b) => a.at.localeCompare(b.at));
}
