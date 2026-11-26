// Принятие правил недели и сцена «до и после». Модель не вызывается.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { leaders, people, rules, verdicts } from '../db/schema.ts';
import {
  dependenceOf,
  readAuditChanges,
  readAuditTotals,
  readHistory,
  staffFromVerdict,
  trustOffer,
  type AuthorityRule,
  type Dependence,
  type StaffCard,
} from './dependence.ts';

export async function listAuthorityRules(db: Db, leaderId: string): Promise<AuthorityRule[]> {
  const rows = await db.select().from(rules).where(eq(rules.leaderId, leaderId));
  const persons = await db.select().from(people).where(eq(people.leaderId, leaderId));
  const byId = new Map(persons.map((person) => [person.externalId, person.email]));
  return rows
    .filter((row) => row.kind === 'полномочие' && row.personId && byId.has(row.personId))
    .map((row) => ({
      personId: row.personId,
      email: byId.get(row.personId) ?? '',
      area: row.area,
      limit: Number(row.limitValue),
    }))
    .filter((row) => Number.isFinite(row.limit));
}

export async function weekScene(db: Db, leaderId: string) {
  const [audit, history, acceptedRows, verdictRows] = await Promise.all([
    readAuditTotals(),
    readHistory(),
    db.select().from(rules).where(eq(rules.leaderId, leaderId)),
    db.select().from(verdicts).where(eq(verdicts.leaderId, leaderId)),
  ]);
  const accepted = acceptedRows.length > 0;
  const picture: Dependence = dependenceOf(audit, accepted);
  const offer = trustOffer(history, 'p02', 'скидка');
  const discount = verdictRows.find((row) => row.id === 'v-m062');
  const staff: StaffCard | null = discount
    ? staffFromVerdict({
        summary: discount.summary,
        recommendation: discount.recommendation,
        basis: discount.basis,
        context: discount.context,
        category: discount.category,
      })
    : null;
  return {
    accepted,
    before: picture.before,
    after: picture.after,
    current: accepted ? picture.after : picture.before,
    flowHours: picture.flowHours,
    stillHours: picture.stillHours,
    stoppedLetters: picture.stoppedLetters,
    stoppedMeetings: picture.stoppedMeetings,
    digestLetters: picture.digestLetters,
    digestMeetings: picture.digestMeetings,
    offer: offer.ready ? offer.title : '',
    rules: acceptedRows.length,
    staff,
  };
}

export async function acceptWeek(db: Db, leaderId: string) {
  const [changes, history] = await Promise.all([readAuditChanges(), readHistory()]);
  const offer = trustOffer(history, 'p02', 'скидка');
  const now = new Date();
  await db.delete(rules).where(eq(rules.leaderId, leaderId));
  const values = changes.map((change) => ({
    id: `audit:${leaderId}:${change.cause}`,
    leaderId,
    kind: 'фильтр',
    title: change.title,
    personId: '',
    area: '',
    limitValue: '',
    cause: change.cause,
    acceptedAt: now,
  }));
  if (offer.ready) {
    values.push({
      id: `auth:${leaderId}:p02:скидка`,
      leaderId,
      kind: 'полномочие',
      title: offer.title,
      personId: 'p02',
      area: 'скидка',
      limitValue: String(offer.limit),
      cause: '',
      acceptedAt: now,
    });
  }
  if (values.length) await db.insert(rules).values(values);
  return weekScene(db, leaderId);
}

export async function acceptWeekByChat(db: Db, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const scene = await acceptWeek(db, leader.id);
  return `Правила приняты. Индекс ${scene.before}% → ${scene.after}%`;
}
