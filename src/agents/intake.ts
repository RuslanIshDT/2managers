// Письмо из ящика → вердикт K2 → карточка или ответ.
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, kpis, leaders, mailIn, people, revisions, tasks, verdicts } from '../db/schema.ts';
import { mailConfig, sendMail, type MailboxLetter } from '../mail.ts';
import { sendDecisionCard } from '../telegram.ts';
import { staffFromVerdict } from './dependence.ts';
import { kpiStatus } from './k1.ts';
import { cardText, chainKey, discountLimit, enforce, judgeLetter, letterPrompt, type ModelVerdict, type Ruled } from './k2.ts';
import { withLlmScope } from '../llm.ts';
import { letterHits } from './replay.ts';
import { applyRevision, revisionPrompt } from './revisions.ts';
import { listFlowRules } from './week.ts';

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
  риски: '',
  если_не_решить: '',
  уверенность: 0,
};

export interface SeedLetter {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  received: string;
  repeat?: boolean;
}

export function isOwnAddress(from: string, mailbox: string): boolean {
  const own = mailbox.trim().toLowerCase();
  return own.length > 0 && from.trim().toLowerCase() === own;
}

export async function dropOwnMailbox(db: Db, leaderId: string): Promise<number> {
  const mailbox = mailConfig()?.user ?? '';
  if (!mailbox) return 0;
  const rows = await db
    .select({ messageId: mailIn.messageId, fromEmail: mailIn.fromEmail })
    .from(mailIn)
    .where(eq(mailIn.leaderId, leaderId));
  const ids = rows.filter((row) => isOwnAddress(row.fromEmail, mailbox)).map((row) => row.messageId);
  for (const messageId of ids) {
    await db.delete(verdicts).where(and(eq(verdicts.leaderId, leaderId), eq(verdicts.messageId, messageId)));
    await db.delete(mailIn).where(and(eq(mailIn.leaderId, leaderId), eq(mailIn.messageId, messageId)));
  }
  return ids.length;
}

export function lettersForMailbox(emails: SeedLetter[], subordinateEmails: Set<string>): SeedLetter[] {
  const sorted = [...emails].sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const picked: SeedLetter[] = [];
  for (const email of sorted) {
    if (!subordinateEmails.has(email.fromEmail.toLowerCase())) continue;
    const key = chainKey(email.fromEmail, email.subject);
    if (seen.has(key) && !email.repeat) continue;
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
  const authority = await listFlowRules(db, leaderId);
  const revisionRows = await db.select().from(revisions).where(eq(revisions.leaderId, leaderId)).orderBy(asc(revisions.createdAt));
  const edits = revisionRows.map((row) => ({ category: row.category, instead: row.instead }));
  const lines: string[] = [];
  let calls = 0;
  let deferred = 0;

  const mailbox = mailConfig()?.user ?? '';
  const pending = [...letters].sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
  for (const letter of pending) {
    if (isOwnAddress(letter.fromEmail, mailbox)) continue;
    if (seen.has(letter.messageId)) continue;
    const person = persons.find((row) => row.email.toLowerCase() === letter.fromEmail.toLowerCase());
    const boss = person?.role === 'руководитель руководителя';
    if (!person || (person.role !== 'подчинённый' && !boss)) {
      if (letter.marked !== false) continue;
      await db.insert(mailIn).values({
        leaderId,
        messageId: letter.messageId,
        syntheticId: '',
        received: letter.received,
        fromName: letter.fromName,
        fromEmail: letter.fromEmail,
        subject: letter.subject,
        body: letter.body,
        chainKey: chainKey(letter.fromEmail, letter.subject),
      });
      await db.insert(verdicts).values({
        id: `v-${letter.messageId}`.slice(0, 120),
        leaderId,
        messageId: letter.messageId,
        chainKey: chainKey(letter.fromEmail, letter.subject),
        kind: 'не_из_отдела',
        category: 'иное',
        summary: `${letter.fromName}: ${letter.subject}`,
        draft: '',
        basis: 'Адрес не найден среди подчинённых этого руководителя',
        context: '',
        recommendation: '',
        authorityOffer: '',
        risks: '',
        ifNot: '',
        createdAt: new Date(),
      });
      seen.add(letter.messageId);
      lines.push(`${letter.id}: не из отдела`);
      continue;
    }
    const key = chainKey(letter.fromEmail, letter.subject);
    const prior = decisionRows.find((row) => row.chainKey === key || row.id === letter.id) ?? null;
    const ownAuth = authRows.filter((row) => row.personId === person.externalId);
    const limit = discountLimit(ownAuth.map((row) => ({ area: row.area, limit: row.limitValue })));
    const covered = letterHits(letter, authority);
    let ruled: Ruled;
    if (covered && covered.effect !== 'карточка') {
      ruled = {
        kind: 'вернуть',
        category: 'иное',
        summary: covered.effect === 'сам' ? `В пределах принятого права: ${covered.area}` : `Правило потока: ${covered.title}`,
        draft:
          covered.effect === 'сам'
            ? 'Это уже ваше право по принятому правилу. Решите сами и напишите адресату.'
            : 'Это письмо закрыто принятым правилом потока и руководителю не передаётся.',
        basis: `Правило: ${covered.title}`,
        context: '',
        recommendation: '',
        risks: '',
        ifNot: '',
        authorityOffer: '',
        ask: false,
        send: covered.effect === 'сам',
      };
    } else if (prior) {
      ruled = enforce(DUMMY, `${letter.subject}\n${letter.body}`, limit, prior, boss);
    } else if (calls >= modelBudget) {
      deferred += 1;
      continue;
    } else {
      const ownKpi = kpiRows.filter((row) => row.personId === person.externalId);
      const ownTasks = taskRows.filter((row) => row.ownerName === person.name);
      const model = await withLlmScope(
        { agent: 'k2', leaderId, operationId: `k2:${letter.id}`, title: letter.subject.slice(0, 180) || 'Разбор письма' },
        () => judgeLetter({
        purpose: `k2:${letter.id}`,
        prompt: letterPrompt({
          profile: leaderRow.profile,
          person: personBlock(person, ownAuth, ownKpi),
          tasks: ownTasks.map((row) => `${row.title}, срок ${row.dueOn}, ${row.status}`).join('\n'),
          subject: letter.subject,
          body: letter.body,
          limit,
          revisions: revisionPrompt(edits),
        }),
      }),
      );
      calls += 1;
      ruled = enforce(model, `${letter.subject}\n${letter.body}`, limit, null, boss);
    }
    ruled = { ...ruled, draft: applyRevision(ruled.draft, ruled.category, edits) };

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
        awaitingEdit: false,
        createdAt: new Date(),
      });
      try {
        const staff = staffFromVerdict({
          summary: ruled.summary || letter.subject,
          recommendation: ruled.recommendation,
          basis: ruled.basis,
          context: ruled.context,
          risks: ruled.risks,
          ifNot: ruled.ifNot,
        });
        if (!staff) throw new Error('Карточка без вывода и рекомендации');
        await sendDecisionCard(
          cardText({
            who: `${letter.fromName}: ${letter.subject}`,
            ...staff,
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
        awaitingEdit: false,
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
        awaitingEdit: false,
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
        awaitingEdit: false,
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
      risks: ruled.risks,
      ifNot: ruled.ifNot,
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
  return applyLeaderAction(db, leader.id, action, decisionId);
}

export async function applyLeaderAction(db: Db, leaderId: string, action: string, decisionId: string): Promise<string> {
  const [decision] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, decisionId), eq(decisions.leaderId, leaderId)))
    .limit(1);
  if (!decision) return 'Решение не найдено';
  if (decision.status !== 'ждёт') return `Уже ${decision.status}`;
  if (action === 'edit') {
    await db.update(decisions).set({ awaitingEdit: true }).where(eq(decisions.id, decision.id));
    return 'Напишите, что поставить вместо черновика. Та же формулировка попадёт в следующее письмо этой категории.';
  }
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

export async function saveEditText(db: Db, chatId: string, text: string): Promise<string | null> {
  const instead = text.trim();
  if (instead.length < 3) return null;
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return null;
  const [decision] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.leaderId, leader.id), eq(decisions.awaitingEdit, true)))
    .limit(1);
  if (!decision) return null;
  const [verdict] = await db.select().from(verdicts).where(eq(verdicts.id, `v-${decision.id}`)).limit(1);
  const category = verdict?.category || 'иное';
  await db.insert(revisions).values({
    id: randomUUID(),
    leaderId: leader.id,
    category,
    instead,
    createdAt: new Date(),
  });
  await db
    .update(decisions)
    .set({ draft: applyRevision(decision.draft, category, [{ category, instead }]), awaitingEdit: false })
    .where(eq(decisions.id, decision.id));
  return `Правка записана для категории «${category}». Черновик этого решения обновлён, следующее письмо той же категории её учтёт.`;
}

export function hideMailbox(text: string, mailbox: string): string {
  const own = mailbox.trim();
  if (!own) return text;
  return text.replace(new RegExp(own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').replace(/[ \t]{2,}/g, ' ').trim();
}

export async function requestFeed(db: Db, leaderId: string) {
  await dropOwnMailbox(db, leaderId);
  const mailbox = mailConfig()?.user ?? '';
  const [hidden] = await db
    .select({ n: count() })
    .from(verdicts)
    .where(and(eq(verdicts.leaderId, leaderId), eq(verdicts.kind, 'не_из_отдела')));
  const rows = await db
    .select()
    .from(verdicts)
    .where(and(eq(verdicts.leaderId, leaderId), ne(verdicts.kind, 'не_из_отдела')))
    .orderBy(desc(verdicts.createdAt))
    .limit(20);
  return {
    outside: Number(hidden?.n ?? 0),
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      category: row.category,
      summary: hideMailbox(row.summary, mailbox),
      basis: hideMailbox(row.basis, mailbox),
    })),
  };
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
