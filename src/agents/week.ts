// Принятие правил недели и сцена «до и после». Модель не вызывается.
import { readFile } from 'node:fs/promises';
import { clockFor } from './scene.ts';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, seriesKind, emails, flowReports, leaders, mailIn, meetings, people, rules, verdicts } from '../db/schema.ts';
import { staffFromVerdict, type StaffCard } from './dependence.ts';
import { historyForLeader } from './trust.ts';
import { audienceEmails, loadAudiences } from './audience.ts';
import { confirmationPoints, leaderMustConfirm } from './confirm.ts';
import {
  askShare,
  replayWeek,
  rulesFromAudit,
  subjectKey,
  trustOffers,
  waitingHours,
  type AuditPiece,
  type FlowRule,
} from './replay.ts';

async function historyOf(db: Db, leaderId: string) {
  return historyForLeader(db, leaderId);
}

export async function listFlowRules(db: Db, leaderId: string): Promise<FlowRule[]> {
  const rows = await db.select().from(rules).where(eq(rules.leaderId, leaderId));
  return rows.map((row) => ({
    kind: row.kind === 'встреча' || row.kind === 'полномочие' ? row.kind : 'письмо',
    title: row.title,
    personId: row.personId,
    area: row.area,
    limitValue: row.limitValue,
    fromEmail: row.fromEmail,
    subjectKey: row.subjectKey,
    seriesKey: row.seriesKey,
    effect: row.effect === 'стоп' || row.effect === 'дайджест' || row.effect === 'сам' || row.effect === 'карточка' ? row.effect : 'стоп',
    cause: row.cause,
  }));
}

export async function weekScene(db: Db, leaderId: string) {
  const [history, ruleRows, verdictRows, decisionRows, letterRows, meetingRows] = await Promise.all([
    historyOf(db, leaderId),
    listFlowRules(db, leaderId),
    db.select().from(verdicts).where(eq(verdicts.leaderId, leaderId)),
    db.select().from(decisions).where(eq(decisions.leaderId, leaderId)),
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
  ]);
  const accepted = ruleRows.length > 0;
  const picture = replayWeek(
    letterRows.map((row) => ({ fromEmail: row.fromEmail, subject: row.subject, body: row.body })),
    meetingRows.map((row) => ({ summary: row.summary })),
    ruleRows,
    accepted,
  );
  await closeReturned(db, decisionRows, verdictRows);
  const offers = trustOffers(history, await currentRights(db, leaderId));
  const asks = verdictRows.filter((row) => row.kind === 'нужен_руководитель');
  const asked = [...asks].reverse().find((row) => row.recommendation.trim()) ?? asks.at(-1);
  const staff: StaffCard | null = asked
    ? staffFromVerdict({
        summary: asked.summary,
        recommendation: asked.recommendation,
        basis: asked.basis,
        context: asked.context,
        risks: asked.risks,
        ifNot: asked.ifNot,
      })
    : null;
  return {
    accepted,
    before: picture.before,
    after: picture.after,
    current: accepted ? picture.after : picture.before,
    letters: picture.letters,
    meetings: picture.meetings,
    stillLetters: picture.stillLetters,
    stillMeetings: picture.stillMeetings,
    stoppedLetters: picture.stoppedLetters,
    stoppedMeetings: picture.stoppedMeetings,
    digestLetters: picture.digestLetters,
    digestMeetings: picture.digestMeetings,
    gluedLetters: picture.gluedLetters,
    gluedMeetings: picture.gluedMeetings,
    remaining: picture.remaining,
    offers: offers.map((offer) => offer.title),
    rules: ruleRows.length,
    askPercent: askShare(verdictRows.map((row) => row.kind)),
    waitingHours: waitingHours(decisionRows, clockFor(leaderId).now),
    staff,
    waiting: decisionRows
      .filter((row) => row.status === 'ждёт')
      .map((row) => {
        const verdict = verdictRows.find((item) => item.id === `v-${row.id}`);
        return {
          id: row.id,
          summary: row.summary,
          recommendation: verdict?.recommendation ?? '',
          basis: verdict?.basis ?? '',
          risks: verdict?.risks ?? '',
          ifNot: verdict?.ifNot ?? '',
          context: verdict?.context ?? '',
        };
      }),
  };
}

export function freshVerdictKind(
  decisionId: string,
  rows: { id: string; messageId: string; kind: string; createdAt: Date }[],
): string | null {
  const fresh = rows
    .filter((row) => row.id === `v-${decisionId}` || row.messageId === decisionId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return fresh?.kind ?? null;
}

async function closeReturned(
  db: Db,
  decisionRows: { id: string; status: string }[],
  verdictRows: { id: string; messageId: string; kind: string; createdAt: Date }[],
) {
  for (const decision of decisionRows) {
    if (decision.status !== 'ждёт') continue;
    if (freshVerdictKind(decision.id, verdictRows) !== 'вернуть') continue;
    await db.update(decisions).set({ status: 'закрыто', awaitingEdit: false }).where(eq(decisions.id, decision.id));
    decision.status = 'закрыто';
  }
}

export async function acceptWeek(db: Db, leaderId: string) {
  const [history, persons, pieces] = await Promise.all([historyOf(db, leaderId), db.select().from(people).where(eq(people.leaderId, leaderId)), readPieces(db, leaderId)]);
  const offers = trustOffers(history, await currentRights(db, leaderId));
  const emailByPerson = new Map(persons.map((person) => [person.externalId, person.email]));
  const categories = await categoriesByLetter(db, leaderId);
  const audiences = await loadAudiences(db, leaderId);
  const built = rulesFromAudit(pieces, offers, emailByPerson, categories.map, categories.points, audienceEmails(audiences), categories.analyzed);
  const now = new Date();
  await db.delete(rules).where(eq(rules.leaderId, leaderId));
  if (built.length) {
    await db.insert(rules).values(
      built.map((rule, index) => ({
        id: `rule:${leaderId}:${index}`,
        leaderId,
        kind: rule.kind,
        title: rule.title,
        personId: rule.personId,
        area: rule.area,
        limitValue: rule.limitValue,
        cause: rule.cause,
        fromEmail: rule.fromEmail,
        subjectKey: rule.subjectKey,
        seriesKey: rule.seriesKey,
        effect: rule.effect,
        acceptedAt: now,
      })),
    );
  }
  return weekScene(db, leaderId);
}

export async function acceptWeekByChat(db: Db, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const scene = await acceptWeek(db, leader.id);
  return `Правила приняты. Индекс ${scene.before}% → ${scene.after}%`;
}

async function categoriesByLetter(db: Db, leaderId: string): Promise<{ map: Map<string, string>; points: string[]; analyzed: Set<string> }> {
  const [rows, kinds, leaderRows, verdictRows, inbox] = await Promise.all([
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
    db.select().from(seriesKind).where(eq(seriesKind.leaderId, leaderId)),
    db.select({ profile: leaders.profile }).from(leaders).where(eq(leaders.id, leaderId)).limit(1),
    db.select({ id: verdicts.id, messageId: verdicts.messageId, category: verdicts.category }).from(verdicts).where(eq(verdicts.leaderId, leaderId)),
    db.select({ syntheticId: mailIn.syntheticId, messageId: mailIn.messageId }).from(mailIn).where(eq(mailIn.leaderId, leaderId)),
  ]);
  const points = confirmationPoints(leaderRows[0]?.profile ?? '');
  const letters = letterCategories(
    rows.map((row) => ({ id: row.externalId, fromEmail: row.fromEmail, subject: row.subject })),
    verdictRows,
    inbox,
    points,
  );
  for (const row of kinds) if (row.category) letters.map.set(`встреча|${subjectKey(row.seriesKey)}`, row.category);
  return { ...letters, points };
}

// Категория письма — из разбора помощника. Письмо без разбора в набор разобранных не входит.
export function letterCategories(
  letters: { id: string; fromEmail: string; subject: string }[],
  verdicts: { id: string; messageId: string; category: string }[],
  links: { syntheticId: string; messageId: string }[],
  points: string[],
): { map: Map<string, string>; analyzed: Set<string> } {
  const byMessage = new Map<string, string[]>();
  for (const verdict of verdicts) {
    const ids = [verdict.messageId, verdict.id.replace(/^v-/, '')];
    for (const id of ids) {
      const list = byMessage.get(id) ?? [];
      list.push(verdict.category);
      byMessage.set(id, list);
    }
  }
  const messagesOf = new Map<string, string[]>();
  for (const link of links) {
    const list = messagesOf.get(link.syntheticId) ?? [];
    list.push(link.messageId);
    messagesOf.set(link.syntheticId, list);
  }
  const map = new Map<string, string>();
  const analyzed = new Set<string>();
  for (const letter of letters) {
    const ids = [letter.id, ...(messagesOf.get(letter.id) ?? [])];
    const categories = ids.flatMap((id) => byMessage.get(id) ?? []);
    if (!categories.length) continue;
    const key = `${letter.fromEmail.toLowerCase()}|${subjectKey(letter.subject)}`;
    analyzed.add(key);
    const category = categories.find((item) => leaderMustConfirm(item, points)) ?? categories.at(-1) ?? '';
    const prev = map.get(key);
    if (!prev || leaderMustConfirm(category, points)) map.set(key, category);
  }
  return { map, analyzed };
}

export async function ownProposal(db: Db, leaderId: string): Promise<FlowRule[]> {
  const stored = await db.select().from(flowReports).where(eq(flowReports.leaderId, leaderId)).limit(1);
  const pieces = piecesOf(stored[0]?.report);
  if (!pieces.length) return [];
  const [history, persons] = await Promise.all([
    historyOf(db, leaderId),
    db.select().from(people).where(eq(people.leaderId, leaderId)),
  ]);
  const emailByPerson = new Map(persons.map((person) => [person.externalId, person.email]));
  const categories = await categoriesByLetter(db, leaderId);
  const audiences = await loadAudiences(db, leaderId);
  return rulesFromAudit(
    pieces,
    trustOffers(history, await currentRights(db, leaderId)),
    emailByPerson,
    categories.map,
    categories.points,
    audienceEmails(audiences),
    categories.analyzed,
  );
}

async function readPieces(db: Db, leaderId: string): Promise<AuditPiece[]> {
  const stored = await db.select().from(flowReports).where(eq(flowReports.leaderId, leaderId)).limit(1);
  const report = stored[0]?.report ?? JSON.parse(await readFile('reports/flow-audit.json', 'utf8'));
  return piecesOf(report);
}

function piecesOf(report: unknown): AuditPiece[] {
  const items = (report as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const pieces: AuditPiece[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { item?: { kind?: string; key?: string; title?: string }; audit?: { вердикт?: string; что_изменить?: string; причина?: string } };
    const kind = row.item?.kind;
    if (kind !== 'письма' && kind !== 'встречи') continue;
    pieces.push({
      kind,
      key: row.item?.key ?? '',
      title: row.item?.title ?? '',
      verdict: row.audit?.вердикт ?? '',
      change: row.audit?.что_изменить ?? '',
      cause: row.audit?.причина ?? '',
    });
  }
  return pieces;
}

async function currentRights(db: Db, leaderId: string) {
  const rows = await db.select().from(authorities).where(eq(authorities.leaderId, leaderId));
  return rows.map((row) => ({ personId: row.personId, area: row.area, limit: row.limitValue }));
}
