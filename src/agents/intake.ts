// Письмо из ящика → вердикт K2 → карточка или ответ.
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, kpis, leaders, mailIn, people, tasks, verdicts } from '../db/schema.ts';
import { mailConfig, sendMail, type MailboxLetter } from '../mail.ts';
import { sendDecisionCard } from '../telegram.ts';
import { kpiStatus } from './k1.ts';
import { cardText, chainKey, discountLimit, enforce, judgeLetter, letterPrompt, type ModelVerdict, type Ruled } from './k2.ts';

const REPEAT_ID = 'm079';
const DUMMY: ModelVerdict = {
  вердикт: 'вернуть',
  в_полномочиях: 'неясно',
  есть_предложение: 'нет',
  только_руководитель: 'нет',
  категория: 'иное',
  суть: '',
  контекст: '',
  рекомендация: '',
  черновик_ответа: '',
  предложение_полномочия: '',
  основание: '',
  уверенность: 0,
};

export interface SeedLetter {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  received: string;
}

export function lettersForMailbox(emails: SeedLetter[], subordinateEmails: Set<string>): SeedLetter[] {
  const sorted = [...emails].sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const picked: SeedLetter[] = [];
  for (const email of sorted) {
    if (!subordinateEmails.has(email.fromEmail.toLowerCase())) continue;
    const key = chainKey(email.fromEmail, email.subject);
    if (seen.has(key) && email.id !== REPEAT_ID) continue;
    seen.add(key);
    picked.push(email);
  }
  return picked;
}

export async function pullInbox(db: Db, leaderId: string, letters: MailboxLetter[], modelBudget: number) {
  const [leaderRow] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leaderRow) throw new Error('Руководитель не найден');
  const known = await db.select({ id: mailIn.messageId }).from(mailIn).where(eq(mailIn.leaderId, leaderId));
  const seen = new Set(known.map((row) => row.id));
  const persons = await db.select().from(people).where(eq(people.leaderId, leaderId));
  const kpiRows = await db.select().from(kpis).where(eq(kpis.leaderId, leaderId));
  const authRows = await db.select().from(authorities).where(eq(authorities.leaderId, leaderId));
  const taskRows = await db.select().from(tasks).where(eq(tasks.leaderId, leaderId));
  const decisionRows = await db.select().from(decisions).where(eq(decisions.leaderId, leaderId));
  const lines: string[] = [];
  let calls = 0;
  let deferred = 0;

  const pending = [...letters].sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
  for (const letter of pending) {
    if (seen.has(letter.messageId)) continue;
    const person = persons.find((row) => row.email.toLowerCase() === letter.fromEmail.toLowerCase());
    if (!person || person.role !== 'подчинённый') continue;
    const key = chainKey(letter.fromEmail, letter.subject);
    const prior = decisionRows.find((row) => row.chainKey === key || row.id === letter.id) ?? null;
    const ownAuth = authRows.filter((row) => row.personId === person.externalId);
    const limit = discountLimit(ownAuth.map((row) => ({ area: row.area, limit: row.limitValue })));
    let ruled: Ruled;
    if (prior) {
      ruled = enforce(DUMMY, `${letter.subject}\n${letter.body}`, limit, prior, false);
    } else if (calls >= modelBudget) {
      deferred += 1;
      continue;
    } else {
      const ownKpi = kpiRows.filter((row) => row.personId === person.externalId);
      const ownTasks = taskRows.filter((row) => row.ownerName === person.name);
      const model = await judgeLetter({
        purpose: `k2:${letter.id}`,
        prompt: letterPrompt({
          profile: leaderRow.profile,
          person: personBlock(person, ownAuth, ownKpi),
          tasks: ownTasks.map((row) => `${row.title}, срок ${row.dueOn}, ${row.status}`).join('\n'),
          subject: letter.subject,
          body: letter.body,
          limit,
        }),
      });
      calls += 1;
      ruled = enforce(model, `${letter.subject}\n${letter.body}`, limit, null, false);
    }

    if (ruled.ask) {
      if (!leaderRow.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
      await db.insert(decisions).values({
        id: letter.id,
        leaderId,
        chainKey: key,
        status: 'ждёт',
        summary: ruled.summary,
        draft: ruled.draft,
        replyTo: letter.fromEmail,
        replyName: letter.fromName,
        subject: letter.subject,
        createdAt: new Date(),
      });
      try {
        await sendDecisionCard(
          cardText({
            who: `${letter.fromName}: ${letter.subject}`,
            summary: ruled.summary,
            context: ruled.context,
            recommendation: ruled.recommendation,
            draft: ruled.draft,
          }),
          letter.id,
          leaderRow.telegramChatId,
        );
      } catch (err) {
        await db.delete(decisions).where(eq(decisions.id, letter.id));
        throw err;
      }
      decisionRows.push({
        id: letter.id,
        leaderId,
        chainKey: key,
        status: 'ждёт',
        summary: ruled.summary,
        draft: ruled.draft,
        replyTo: letter.fromEmail,
        replyName: letter.fromName,
        subject: letter.subject,
        createdAt: new Date(),
      });
    } else if (ruled.send) {
      await deliverReply(letter.fromName, letter.fromEmail, letter.subject, ruled.draft);
      await db.insert(decisions).values({
        id: letter.id,
        leaderId,
        chainKey: key,
        status: 'исполнено',
        summary: ruled.summary,
        draft: ruled.draft,
        replyTo: letter.fromEmail,
        replyName: letter.fromName,
        subject: letter.subject,
        createdAt: new Date(),
      });
      decisionRows.push({
        id: letter.id,
        leaderId,
        chainKey: key,
        status: 'исполнено',
        summary: ruled.summary,
        draft: ruled.draft,
        replyTo: letter.fromEmail,
        replyName: letter.fromName,
        subject: letter.subject,
        createdAt: new Date(),
      });
    }

    await db.insert(mailIn).values({
      leaderId,
      messageId: letter.messageId,
      syntheticId: letter.id,
      received: letter.received,
      fromName: letter.fromName,
      fromEmail: letter.fromEmail,
      subject: letter.subject,
      body: letter.body,
      chainKey: key,
    });
    await db.insert(verdicts).values({
      id: `v-${letter.id}`,
      leaderId,
      messageId: letter.messageId,
      chainKey: key,
      kind: ruled.kind,
      category: ruled.category,
      summary: ruled.summary,
      draft: ruled.draft,
      basis: ruled.basis,
      context: ruled.context,
      recommendation: ruled.recommendation,
      authorityOffer: ruled.authorityOffer,
      createdAt: new Date(),
    });
    seen.add(letter.messageId);
    lines.push(`${letter.id}: ${ruled.kind}`);
  }

  return { lines, calls, deferred };
}

export async function applyClick(db: Db, action: string, decisionId: string, chatId: string): Promise<string> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return 'Чат не привязан';
  const [decision] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, decisionId), eq(decisions.leaderId, leader.id)))
    .limit(1);
  if (!decision) return 'Решение не найдено';
  if (decision.status !== 'ждёт') return `Уже ${decision.status}`;
  if (action === 'edit') return 'Правка текстом пока не меняет черновик';
  if (action === 'approve') {
    await deliverReply(decision.replyName, decision.replyTo, decision.subject, decision.draft);
    await db.update(decisions).set({ status: 'исполнено' }).where(eq(decisions.id, decision.id));
    return 'Ответ отправлен';
  }
  const status = action === 'reject' ? 'отклонено' : action === 'defer' ? 'отложено' : '';
  if (!status) return 'Неизвестная кнопка';
  await db.update(decisions).set({ status }).where(eq(decisions.id, decision.id));
  return status === 'отклонено' ? 'Отклонено' : 'Отложено';
}

export async function requestFeed(db: Db, leaderId: string) {
  const rows = await db.select().from(verdicts).where(eq(verdicts.leaderId, leaderId)).orderBy(desc(verdicts.createdAt)).limit(20);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    category: row.category,
    summary: row.summary,
    basis: row.basis,
  }));
}

export async function deliverReply(name: string, email: string, subject: string, draft: string) {
  const cfg = mailConfig();
  if (!cfg) throw new Error('Яндекс Почта не настроена');
  await sendMail(
    cfg.user,
    `Re: ${subject}`,
    `Кому: ${name} <${email}>\nАдрес подчинённого синтетический, поэтому письмо ушло в тестовый ящик.\n\n${draft}`,
  );
}

function personBlock(
  person: { name: string; position: string; zone: string; goal: string; leaderGoal: string },
  auths: { area: string; limitValue: string; unit: string; note: string }[],
  points: { name: string; unit: string; better: string; week: string; plan: string; fact: string }[],
): string {
  const weeks = points
    .filter((point) => point.week !== 'квартал')
    .sort((a, b) => a.week.localeCompare(b.week));
  const latest = weeks.at(-1);
  const lag = weeks.filter((point) => kpiStatus(point.better, point.plan, point.fact) === 'отстаёт').length;
  const kpiLine = latest
    ? `${latest.name}: последняя неделя ${latest.fact} из ${latest.plan} ${latest.unit}, недель с отставанием ${lag} из ${weeks.length}`
    : 'KPI нет';
  const powers = auths.map((item) => `${item.area} ${item.limitValue} ${item.unit} (${item.note})`).join('; ');
  return [
    `${person.name}, ${person.position}`,
    `Зона: ${person.zone || '—'}`,
    `Цель: ${person.goal || '—'}${person.leaderGoal ? `, цель профиля ${person.leaderGoal}` : ''}`,
    `Полномочия: ${powers || 'нет'}`,
    kpiLine,
  ].join('\n');
}
