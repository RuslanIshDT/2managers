// Письмо из ящика → вердикт K2 → карточка или ответ.
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, emails, kpis, leaders, mailActions, mailIn, people, revisions, tasks, verdicts } from '../db/schema.ts';
import { mailConfig, sendMail, type MailboxLetter } from '../mail.ts';
import { sendDecisionCard } from '../telegram.ts';
import { staffFromVerdict } from './dependence.ts';
import { kpiStatus, personAddresses } from './k1.ts';
import { forceMailAction, judgeMail } from './accuracy.ts';
import { cardText, chainKey, discountLimit, enforce, failedRuling, judgeLetter, letterPrompt, textSignals, type ModelVerdict, type Ruled } from './k2.ts';
import { withLlmScope } from '../llm.ts';
import { judgeWithTools, k2Context, stepsWords } from './k2-tools.ts';
import { readHistory } from './dependence.ts';
import { letterHits } from './replay.ts';
import { applyRevision, revisionPrompt } from './revisions.ts';
import { listFlowRules } from './week.ts';
import { clockFor, letterMoment, moscowStamp } from './scene.ts';
import { changeWords, termChanges, type TermChange } from './terms.ts';

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

// notify: false — карточка не уходит в Telegram (сброс стенда готовит сцену, а не шлёт сообщение).
export async function pullInbox(db: Db, leaderId: string, letters: MailboxLetter[], modelBudget: number, options: { notify?: boolean } = {}) {
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
  const history = await readHistory(`data/${leaderId}`).catch(() => []);
  const catalog = await db
    .select({ id: emails.externalId, fromEmail: emails.fromEmail, subject: emails.subject, body: emails.body })
    .from(emails)
    .where(eq(emails.leaderId, leaderId));
  const pastMail = await db
    .select({ fromEmail: mailIn.fromEmail, subject: mailIn.subject, received: mailIn.received, kind: verdicts.kind })
    .from(mailIn)
    .leftJoin(verdicts, and(eq(verdicts.leaderId, mailIn.leaderId), eq(verdicts.messageId, mailIn.messageId)))
    .where(eq(mailIn.leaderId, leaderId))
    .orderBy(asc(mailIn.received));
  const lines: string[] = [];
  let calls = 0;
  let deferred = 0;

  const clock = clockFor(leaderId);
  const mailbox = mailConfig()?.user ?? '';
  const pending = [...letters].sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
  for (const letter of pending) {
    try {
      if (isOwnAddress(letter.fromEmail, mailbox)) continue;
      if (seen.has(letter.messageId)) continue;
      const moment = letterMoment(letter.received, letter.marked !== false, clock);
      const stamp = moscowStamp(moment);
      const person = persons.find((row) => personAddresses(row).includes(letter.fromEmail.toLowerCase()));
      const boss = person?.role === 'руководитель руководителя';
      if (!person || (person.role !== 'подчинённый' && !boss)) {
        if (letter.marked !== false) continue;
        if (calls >= modelBudget) {
          deferred += 1;
          continue;
        }
        const letterText = `От: ${letter.fromName}\nТема: ${letter.subject}\n${letter.body}`;
        const chosen = await withLlmScope(
          { agent: 'accuracy', leaderId, operationId: `mail:${letter.messageId}`.slice(0, 180), title: letter.subject.slice(0, 180) || 'Разбор письма' },
          () => judgeMail({ purpose: `accuracy:${letter.id}`, profile: leaderRow.profile, letter: letterText }),
        );
        calls += 1;
        const ruled = forceMailAction(letterText, false, chosen);
        const signal = textSignals(letterText).category ?? 'иное';
        const key = chainKey(letter.fromEmail, letter.subject);
        const outsideChanges = termChanges(await chainBefore(db, leaderId, key, letter, catalog), `${letter.subject}\n${letter.body}`);
        await db.insert(mailIn).values({
          leaderId,
          messageId: letter.messageId,
          syntheticId: '',
          received: stamp,
          fromName: letter.fromName,
          fromEmail: letter.fromEmail,
          subject: letter.subject,
          body: letter.body,
          chainKey: key,
        });
        await db.insert(verdicts).values({
          id: `v-${letter.messageId}`.slice(0, 120),
          leaderId,
          messageId: letter.messageId,
          chainKey: key,
          kind: ruled.action,
          category: signal,
          summary: `${letter.fromName}: ${letter.subject}. Действие: ${actionWords(ruled.action)}`,
          draft: '',
          basis: ruled.forced ? 'Категория N1: письмо не уходит без подтверждения руководителя' : 'Тот же разбор действия, что для точности писем. Адрес не из отдела',
          context: '',
          recommendation: '',
          authorityOffer: '',
          risks: '',
          ifNot: '',
          createdAt: new Date(),
        });
        await db
          .insert(mailActions)
          .values({ leaderId, chainKey: key, action: ruled.action, forced: ruled.forced, createdAt: new Date() })
          .onConflictDoUpdate({ target: [mailActions.leaderId, mailActions.chainKey], set: { action: ruled.action, forced: ruled.forced } });
        if (ruled.action === 'спросить_руководителя') {
          const made = await askOutside(db, leaderRow, { id: letter.id, fromName: letter.fromName, fromEmail: letter.fromEmail, subject: letter.subject }, key, moment, outsideChanges);
          if (made) {
            for (const row of decisionRows) if (row.chainKey === key && row.status === 'ждёт' && row.id !== made.id) row.status = 'заменено';
            decisionRows.push(made);
          }
        }
        seen.add(letter.messageId);
        lines.push(`${letter.id}: ${actionWords(ruled.action)}`);
        continue;
      }
      const key = chainKey(letter.fromEmail, letter.subject);
      const prior = latestDecision(decisionRows, key, letter.id);
      // Прежнее решение по цепочке принималось на прежних условиях: новые процент, сумма, срок или обязательство — не повтор.
      const changes: TermChange[] = prior ? termChanges(await chainBefore(db, leaderId, key, letter, catalog, prior.subject), `${letter.subject}\n${letter.body}`) : [];
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
      } else if (prior && !changes.length) {
        ruled = enforce(DUMMY, `${letter.subject}\n${letter.body}`, limit, prior, boss);
      } else if (calls >= modelBudget) {
        deferred += 1;
        continue;
      } else {
        const ownKpi = kpiRows.filter((row) => row.personId === person.externalId);
        const ownTasks = taskRows.filter((row) => row.ownerName === person.name);
        const ctx = k2Context(person, { authorities: authRows, kpi: kpiRows, tasks: taskRows, history, mail: pastMail, revisions: edits });
        const modelBody = changes.length && prior ? `${letter.body}\n\n${changeNote(prior, changes)}` : letter.body;
        let steps = '';
        const judged = await withLlmScope(
          { agent: 'k2', leaderId, operationId: `k2:${letter.id}`, title: letter.subject.slice(0, 180) || 'Разбор письма' },
          () => judgeWithTools({ purpose: `k2:${letter.id}`, profile: leaderRow.profile, subject: letter.subject, body: modelBody, ctx })
            .then((run) => {
              steps = stepsWords(run.steps);
              return run.verdict;
            })
            .catch((err: unknown) => {
              // Инструменты не сработали — прежний разбор одним запросом с готовой карточкой.
              console.error('K2 с инструментами не сработал', letter.id, err instanceof Error ? err.message : err);
              return judgeLetter({
                purpose: `k2:${letter.id}`,
                prompt: letterPrompt({
                  profile: leaderRow.profile,
                  person: personBlock(person, ownAuth, ownKpi),
                  tasks: ownTasks.map((row) => `${row.title}, срок ${row.dueOn}, ${row.status}`).join('\n'),
                  subject: letter.subject,
                  body: modelBody,
                  limit,
                  revisions: revisionPrompt(edits),
                }),
              });
            }),
        ).then(
          (model) => ({ model, error: '' }),
          (err: unknown) => ({ model: null, error: err instanceof Error ? err.message : String(err) }),
        );
        calls += 1;
        const letterText = `${letter.subject}\n${letter.body}`;
        ruled = judged.model ? enforce(judged.model, letterText, limit, prior, boss, changes) : failedRuling(letterText, judged.error, boss);
        if (!judged.model && changes.length) ruled = { ...ruled, summary: `Условия изменились: ${changeWords(changes)}. ${ruled.summary}` };
        if (steps) ruled = { ...ruled, context: [ruled.context, steps].filter(Boolean).join('\n') };
      }
      ruled = { ...ruled, draft: applyRevision(ruled.draft, ruled.category, edits) };

      if (ruled.ask) {
        if (changes.length) await supersede(db, leaderId, key, letter.id, decisionRows);
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
          createdAt: moment,
        });
        if (options.notify !== false) try {
          if (!leaderRow.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
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
          // Решение остаётся в кабинете; без карточки письмо не разбирается заново.
          console.error('Карточка в Telegram не ушла', letter.id, err instanceof Error ? err.message : err);
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
          createdAt: moment,
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
          createdAt: moment,
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
          createdAt: moment,
        });
      }

      await db.insert(mailIn).values({
        leaderId,
        messageId: letter.messageId,
        syntheticId: letter.id,
        received: stamp,
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
      }).onConflictDoNothing();
      seen.add(letter.messageId);
      lines.push(`${letter.id}: ${ruled.kind}`);
    } catch (err) {
      // Сбой одного письма не останавливает ящик: письмо записано и ждёт руководителя, повторного вызова нет.
      console.error('Письмо не разобрано', letter.id, err instanceof Error ? err.message : err);
      await markBroken(db, leaderId, letter, err);
      seen.add(letter.messageId);
      lines.push(`${letter.id}: не разобрано`);
    }
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
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const local = own.split('@')[0] ?? '';
  let next = text.replace(new RegExp(escape(own), 'gi'), '');
  if (local.length >= 4) next = next.replace(new RegExp(escape(local), 'gi'), '');
  return next.replace(/[ \t]{2,}/g, ' ').trim();
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

export async function rejudgeOutside(db: Db, leaderId: string, modelBudget: number) {
  const [leaderRow] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leaderRow) throw new Error('Руководитель не найден');
  const rows = await db
    .select({
      id: verdicts.id,
      messageId: mailIn.messageId,
      fromName: mailIn.fromName,
      fromEmail: mailIn.fromEmail,
      subject: mailIn.subject,
      body: mailIn.body,
      received: mailIn.received,
    })
    .from(verdicts)
    .innerJoin(mailIn, and(eq(mailIn.leaderId, verdicts.leaderId), eq(mailIn.messageId, verdicts.messageId)))
    .where(and(eq(verdicts.leaderId, leaderId), eq(verdicts.kind, 'не_из_отдела')));
  const lines: string[] = [];
  let calls = 0;
  for (const letter of rows) {
    if (calls >= modelBudget) break;
    const letterText = `От: ${letter.fromName}\nТема: ${letter.subject}\n${letter.body}`;
    const chosen = await withLlmScope(
      { agent: 'accuracy', leaderId, operationId: `mail:${letter.messageId}`.slice(0, 180), title: letter.subject.slice(0, 180) || 'Разбор письма' },
      () => judgeMail({ purpose: `accuracy:${letter.messageId}`, profile: leaderRow.profile, letter: letterText }),
    );
    calls += 1;
    const ruled = forceMailAction(letterText, false, chosen);
    const key = chainKey(letter.fromEmail, letter.subject);
    await db
      .update(verdicts)
      .set({
        kind: ruled.action,
        category: textSignals(letterText).category ?? 'иное',
        summary: `${letter.fromName}: ${letter.subject}. Действие: ${actionWords(ruled.action)}`,
        basis: ruled.forced ? 'Категория N1: письмо не уходит без подтверждения руководителя' : 'Тот же разбор действия, что для точности писем. Адрес не из отдела',
      })
      .where(eq(verdicts.id, letter.id));
    await db
      .insert(mailActions)
      .values({ leaderId, chainKey: key, action: ruled.action, forced: ruled.forced, createdAt: new Date() })
      .onConflictDoUpdate({ target: [mailActions.leaderId, mailActions.chainKey], set: { action: ruled.action, forced: ruled.forced } });
    if (ruled.action === 'спросить_руководителя') {
      const id = letter.messageId.replace(/[<>]/g, '').slice(0, 80);
      await askOutside(db, leaderRow, { id, fromName: letter.fromName, fromEmail: letter.fromEmail, subject: letter.subject }, key, letterMoment(letter.received, true, clockFor(leaderId)));
    }
    lines.push(actionWords(ruled.action));
  }
  return { lines, calls };
}

// Письмо не из отдела, которое нельзя без руководителя (N1 или разбор сказал «спросить»): решение «ждёт» и карточка с кнопками.
async function markBroken(db: Db, leaderId: string, letter: MailboxLetter, err: unknown) {
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, 160);
  const key = chainKey(letter.fromEmail, letter.subject);
  await db
    .insert(mailIn)
    .values({ leaderId, messageId: letter.messageId, syntheticId: letter.id, received: letter.received, fromName: letter.fromName, fromEmail: letter.fromEmail, subject: letter.subject, body: letter.body, chainKey: key })
    .onConflictDoNothing();
  await db
    .insert(verdicts)
    .values({ id: `v-${letter.id}`.slice(0, 120), leaderId, messageId: letter.messageId, chainKey: key, kind: 'нужен_руководитель', category: 'иное', summary: `${letter.fromName}: ${letter.subject}. Разбор прервался`, draft: '', basis: `Разбор прервался (${reason}). Повторного разбора не будет, прочитайте письмо сами`, context: '', recommendation: '', authorityOffer: '', risks: '', ifNot: '', createdAt: new Date() })
    .onConflictDoNothing();
  await db
    .insert(decisions)
    .values({ id: letter.id, leaderId, chainKey: key, status: 'ждёт', summary: `Разбор прервался: ${letter.subject}`.slice(0, 300), draft: '', replyTo: letter.fromEmail, replyName: letter.fromName, subject: letter.subject, awaitingEdit: false, createdAt: new Date() })
    .onConflictDoNothing();
}

async function askOutside(
  db: Db,
  leaderRow: { id: string; telegramChatId: string | null },
  letter: { id: string; fromName: string; fromEmail: string; subject: string },
  key: string,
  moment: Date,
  changes: TermChange[] = [],
) {
  const existing = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.leaderId, leaderRow.id), eq(decisions.chainKey, key))).limit(1);
  if (existing.length && !changes.length) return null;
  if (existing.length) await supersede(db, leaderRow.id, key, letter.id, []);
  const changed = existing.length ? `Условия изменились: ${changeWords(changes)}. ` : '';
  const row = {
    id: letter.id,
    leaderId: leaderRow.id,
    chainKey: key,
    status: 'ждёт',
    summary: `${changed}${letter.subject}`,
    draft: '',
    replyTo: letter.fromEmail,
    replyName: letter.fromName,
    subject: letter.subject,
    awaitingEdit: false,
    createdAt: moment,
  };
  await db.insert(decisions).values(row);
  try {
    if (!leaderRow.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
    await sendDecisionCard(
      cardText({
        who: `${letter.fromName}: ${letter.subject}`,
        вывод: changed ? `${changed}Прежнее решение по этой переписке на новые условия не распространяется` : 'Письмо не из отдела и требует вашего подтверждения',
        рекомендация: 'Подтвердите, если разбираете его сами',
        основание: changed ? 'Категория N1 и новые условия в той же переписке: без подтверждения письмо никуда не уходит' : 'Категория N1: без подтверждения письмо никуда не уходит',
        риски: '',
        если_не_решить: 'Письмо останется без ответа',
        контекст: '',
        draft: '',
      }),
      letter.id,
      leaderRow.telegramChatId,
    );
  } catch (err) {
    console.error('Карточка в Telegram не ушла', letter.id, err instanceof Error ? err.message : err);
  }
  return row;
}

function actionWords(action: string): string {
  if (action === 'спросить_руководителя') return 'спросить руководителя';
  if (action === 'в_сводку') return 'в сводку';
  if (action === 'делегировать') return 'делегировать';
  if (action === 'игнорировать') return 'игнорировать';
  return 'сделать по правилу';
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

// Прежние письма цепочки: лента ящика и каталог руководителя; тема прежнего решения — на случай, если писем нет.
async function chainBefore(
  db: Db,
  leaderId: string,
  key: string,
  letter: { id: string; messageId: string },
  catalog: { id: string; fromEmail: string; subject: string; body: string }[],
  priorSubject = '',
): Promise<string[]> {
  const rows = await db
    .select({ messageId: mailIn.messageId, syntheticId: mailIn.syntheticId, subject: mailIn.subject, body: mailIn.body })
    .from(mailIn)
    .where(and(eq(mailIn.leaderId, leaderId), eq(mailIn.chainKey, key)));
  const texts = rows.filter((row) => row.messageId !== letter.messageId && row.syntheticId !== letter.id).map((row) => `${row.subject}\n${row.body}`);
  for (const row of catalog) {
    if (row.id === letter.id || chainKey(row.fromEmail, row.subject) !== key) continue;
    texts.push(`${row.subject}\n${row.body}`);
  }
  if (priorSubject) texts.push(priorSubject);
  return texts;
}

// Прежняя карточка «ждёт» той же цепочки снимается: её кнопки отвечают «Уже заменено», решать по старым условиям нельзя.
async function supersede(db: Db, leaderId: string, key: string, keepId: string, rows: { id: string; chainKey: string; status: string }[]) {
  await db
    .update(decisions)
    .set({ status: 'заменено', awaitingEdit: false })
    .where(and(eq(decisions.leaderId, leaderId), eq(decisions.chainKey, key), eq(decisions.status, 'ждёт'), ne(decisions.id, keepId)));
  for (const row of rows) if (row.chainKey === key && row.status === 'ждёт' && row.id !== keepId) row.status = 'заменено';
}

export function changeNote(prior: { status: string; summary: string }, changes: TermChange[]): string {
  return `[Помощник: по этой переписке уже было решение «${prior.status}» (${prior.summary.slice(0, 200)}). Условия изменились: ${changeWords(changes)}. Разбери письмо заново по новым условиям.]`;
}

// Последнее решение цепочки: сначала то, что ещё ждёт руководителя, иначе самое позднее.
export function latestDecision<T extends { id: string; chainKey: string; status: string; createdAt: Date }>(rows: T[], key: string, letterId: string): T | null {
  const chain = rows.filter((row) => row.chainKey === key || row.id === letterId);
  if (!chain.length) return null;
  const waiting = chain.filter((row) => row.status === 'ждёт');
  const pool = waiting.length ? waiting : chain;
  return pool.reduce((best, row) => (row.createdAt.getTime() > best.createdAt.getTime() ? row : best));
}
