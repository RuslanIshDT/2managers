// Принятие правил недели и сцена «до и после». Модель не вызывается.
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { decisions, emailEtalon, emails, flowReports, leaders, meetings, people, rules, verdicts } from '../db/schema.ts';
import { readHistory, staffFromVerdict, type StaffCard } from './dependence.ts';
import { leaderMustConfirm } from './k2.ts';
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

async function historyOf(leaderId: string) {
  try {
    return await readHistory(`data/${leaderId}`);
  } catch {
    return [];
  }
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
    historyOf(leaderId),
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
  const offers = trustOffers(history);
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
    waitingHours: waitingHours(decisionRows, new Date()),
    staff,
  };
}

export async function acceptWeek(db: Db, leaderId: string) {
  const [history, persons, pieces] = await Promise.all([historyOf(leaderId), db.select().from(people).where(eq(people.leaderId, leaderId)), readPieces(db, leaderId)]);
  const offers = trustOffers(history);
  const emailByPerson = new Map(persons.map((person) => [person.externalId, person.email]));
  const built = rulesFromAudit(pieces, offers, emailByPerson, await categoriesByLetter(db, leaderId));
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

async function categoriesByLetter(db: Db, leaderId: string): Promise<Map<string, string>> {
  const [marks, rows] = await Promise.all([
    db.select().from(emailEtalon).where(eq(emailEtalon.leaderId, leaderId)),
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
  ]);
  const byId = new Map(marks.map((row) => [row.externalId, row.category]));
  const map = new Map<string, string>();
  for (const row of rows) {
    const category = byId.get(row.externalId) ?? '';
    if (!category) continue;
    const key = `${row.fromEmail.toLowerCase()}|${subjectKey(row.subject)}`;
    const prev = map.get(key);
    if (!prev || leaderMustConfirm(category)) map.set(key, category);
  }
  return map;
}

async function readPieces(db: Db, leaderId: string): Promise<AuditPiece[]> {
  const stored = await db.select().from(flowReports).where(eq(flowReports.leaderId, leaderId)).limit(1);
  const report = stored[0]?.report ?? JSON.parse(await readFile('reports/flow-audit.json', 'utf8'));
  const items = (report as { items?: unknown }).items;
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
