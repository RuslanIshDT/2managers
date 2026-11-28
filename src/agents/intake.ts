// Письмо из ящика → разбор почты (внутр. или внеш.) → карточка руководителю, ответ, пересылка, сводка или без ответа.
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, emails, kpis, leaderActs, leaders, mailIn, people, revisions, tasks, verdicts } from '../db/schema.ts';
import { mailConfig, sendMail, type MailboxLetter } from '../mail.ts';
import { sendDecisionCard } from '../telegram.ts';
import { staffFromVerdict } from './dependence.ts';
import { kpiStatus, personAddresses } from './k1.ts';
import { loadAudienceState, personInAudience } from './audience.ts';
import { amountBlocksRule, breachesFromAnswer, confirmationPoints, normalizeUnit, unitInText } from './confirm.ts';
import { approvalBlock, cardText, chainKey, draftGap, enforce, failedRuling, judgeLetter, letterPrompt, rightRuling, type ModelVerdict, type Ruled } from './k2.ts';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';
import { externalContext, judgeWithTools, k2Context, stepsWords } from './k2-tools.ts';
import { readHistory } from './dependence.ts';
import { letterHits, type FlowRule } from './replay.ts';

function rightsHint(rules: FlowRule[], email: string): string {
  const lines = rules
    .filter((rule) => rule.kind === 'полномочие' && rule.effect === 'сам' && rule.fromEmail.toLowerCase() === email.toLowerCase())
    .map((rule) => {
      const unit = normalizeUnit(rule.limitValue) || unitInText(rule.title);
      const mark = unit === '%' ? '%' : unit ? ` ${unit}` : '';
      return `${rule.area} до ${rule.limitValue}${mark}`;
    });
  return lines.length ? `Принятые права этого отправителя: ${lines.join('; ')}.` : '';
}
import { acceptRewrite, exampleBlock, finishDraft, mailRevisions, rewriteLetter, ruleFromChoice, ruleHint } from './memory.ts';
import { writeLeaderAct } from './acts.ts';
import { applyRevision, revisionPrompt } from './revisions.ts';
import { listFlowRules } from './week.ts';
import { clockFor, letterMoment, moscowStamp } from './scene.ts';
import { changeWords, termChanges, type TermChange } from './terms.ts';

const DUMMY: ModelVerdict = {
  действие: 'в_сводку',
  кому_передать: '',
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
  const verdictRows = await db.select({ chainKey: verdicts.chainKey, kind: verdicts.kind, createdAt: verdicts.createdAt }).from(verdicts).where(eq(verdicts.leaderId, leaderId));
  const authority = await listFlowRules(db, leaderId);
  const revisionRows = await db.select().from(revisions).where(eq(revisions.leaderId, leaderId)).orderBy(asc(revisions.createdAt));
  const edits = mailRevisions(revisionRows.map((row) => ({ category: row.category, area: row.area, instead: row.instead })));
  const actRows = await db.select().from(leaderActs).where(eq(leaderActs.leaderId, leaderId)).orderBy(asc(leaderActs.at));
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

  const audienceState = await loadAudienceState(db, leaderId);
  const audiences = audienceState.audiences;
  const clock = clockFor(leaderId);
  const mailbox = mailConfig()?.user ?? '';
  // Адреса руководителя: ящик помощника и адрес из оргструктуры. В «Кому» — письмо ему; только в копии — для сведения.
  const leaderPerson = persons.find((row) => row.role === 'руководитель');
  const leaderAddresses = new Set([mailbox, ...(leaderPerson ? personAddresses(leaderPerson) : [])].map((value) => value.trim().toLowerCase()).filter(Boolean));
  // Кому можно передать письмо — подчинённые руководителя. Инструмент «люди» показывает их зоны.
  const staff = persons.filter((row) => row.role === 'подчинённый').map((row) => ({ name: row.name, email: row.email }));
  const peopleList = persons.filter((row) => row.role === 'подчинённый').map((row) => ({ name: row.name, position: row.position, zone: row.zone }));
  const pending = [...letters].sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
  for (const letter of pending) {
    try {
      if (isOwnAddress(letter.fromEmail, mailbox)) continue;
      if (seen.has(letter.messageId)) continue;
      const moment = letterMoment(letter.received, letter.marked !== false, clock);
      const stamp = moscowStamp(moment);
      const person = persons.find((row) => personAddresses(row).includes(letter.fromEmail.toLowerCase()));
      // Внутреннее письмо — от человека организации (подчинённый, коллега, начальник); остальные — внешние.
      const inside = Boolean(person && person.role !== 'руководитель');
      const key = chainKey(letter.fromEmail, letter.subject);
      const letterText = `${letter.subject}\n${letter.body}`;
      const ownAuth = person ? authRows.filter((row) => row.personId === person.externalId) : [];
      const points = confirmationPoints(leaderRow.profile);
      const limits = ownAuth.map((row) => ({ area: row.area, limit: row.limitValue, unit: row.unit }));
      const blocked = amountBlocksRule(letterText, limits);
      const areas = limits.flatMap((row) => {
        const limit = Number(String(row.limit).replace(/\s/g, '').replace(',', '.'));
        return Number.isFinite(limit) && normalizeUnit(row.unit) ? [row.area] : [];
      });
      const prior = latestDecision(decisionRows, key, letter.id);
      let ruled: Ruled;
      let named = { area: '', value: '', unit: '', others: '' };
      const covered = letterHits(letter, authority);
      const fromAudience = personInAudience(audiences, { name: letter.fromName, email: letter.fromEmail });
      const copyOnly = (letter.to?.length ?? 0) > 0 && !letter.to!.some((address) => leaderAddresses.has(address));
      if (copyOnly) {
        ruled = copyRuling(letter.cc?.some((address) => leaderAddresses.has(address)) ?? false);
      } else if (covered && covered.effect !== 'карточка' && !blocked && !fromAudience) {
        ruled = {
          kind: covered.effect === 'сам' ? 'вернуть' : 'в_сводку',
          category: 'иное',
          summary: covered.effect === 'сам' ? `В пределах принятого права: ${covered.area}` : `Правило потока: ${covered.title}`,
          draft: covered.effect === 'сам' ? 'Это уже ваше право по принятому правилу. Решите сами и напишите адресату.' : '',
          basis: `Правило: ${covered.title}`,
          context: '',
          recommendation: '',
          risks: '',
          ifNot: '',
          authorityOffer: '',
          ask: false,
          send: covered.effect === 'сам',
        };
      } else {
        // Прежнее решение по переписке принималось на прежних условиях: новые процент, сумма, срок или обязательство — не повтор.
        const before = await chainBefore(db, leaderId, key, letter, catalog, prior?.subject ?? '');
        const changes: TermChange[] = prior || chainSeen(verdictRows, key) ? termChanges(before, letterText) : [];
        const earlier = chainSeen(verdictRows, key);
        if (prior && !changes.length) {
          ruled = enforce(DUMMY, letterText, points, [], prior);
        } else if (!prior && earlier && !changes.length) {
          ruled = repeatRuling(earlier);
        } else if (calls >= modelBudget) {
          deferred += 1;
          continue;
        } else {
          const ctx = inside && person
            ? k2Context(person, { authorities: authRows, kpi: kpiRows, tasks: taskRows, history, mail: pastMail, revisions: edits, people: peopleList })
            : externalContext({ name: letter.fromName, email: letter.fromEmail }, { mail: pastMail, revisions: edits, people: peopleList });
          const modelBody = changes.length && prior ? `${letter.body}\n\n${changeNote(prior, changes)}` : letter.body;
          let steps = '';
          const agent = inside ? 'k2' : 'mail_ext';
          const judged = await withLlmScope(
            { agent, leaderId, operationId: `${agent}:${letter.id}`, title: letter.subject.slice(0, 180) || 'Разбор письма' },
            () => judgeWithTools({
              purpose: `${agent}:${letter.id}`,
              profile: leaderRow.profile,
              subject: letter.subject,
              body: modelBody,
              ctx,
              hints: [ruleHint(edits), rightsHint(authority, letter.fromEmail), exampleBlock(`${letter.subject}\n${letter.body}`, actRows)].filter(Boolean).join('\n\n'),
            })
              .then((run) => {
                steps = stepsWords(run.steps);
                return run.verdict;
              })
              .catch((err: unknown) => {
                // Инструменты не сработали — прежний разбор одним запросом с готовой карточкой.
                console.error('Разбор с инструментами не сработал', letter.id, err instanceof Error ? err.message : err);
                return judgeLetter({
                  purpose: `${agent}:${letter.id}`,
                  points,
                  areas,
                  prompt: letterPrompt({
                    profile: leaderRow.profile,
                    person: person && inside ? personBlock(person, ownAuth, kpiRows.filter((row) => row.personId === person.externalId)) : `${letter.fromName} <${letter.fromEmail}>, не из организации`,
                    tasks: person && inside ? taskRows.filter((row) => row.ownerName === person.name).map((row) => `${row.title}, срок ${row.dueOn}, ${row.status}`).join('\n') : '',
                    subject: letter.subject,
                    body: modelBody,
                    revisions: [revisionPrompt(edits), `Люди руководителя:\n${peopleList.map((row) => `${row.name} — ${row.position}; зона: ${row.zone}`).join('\n')}`].join('\n\n'),
                  }),
                });
              }),
          ).then(
            (model) => ({ model, error: '' }),
            (err: unknown) => ({ model: null, error: err instanceof Error ? err.message : String(err) }),
          );
          calls += 1;
          const breaches = judged.model
            ? breachesFromAnswer({ area: judged.model.область ?? 'нет', value: judged.model.число ?? 0, unit: judged.model.единица ?? '' }, limits)
            : [];
          if (judged.model) {
            named = {
              area: judged.model.область && judged.model.область !== 'нет' ? judged.model.область : '',
              value: judged.model.область && judged.model.область !== 'нет' ? String(judged.model.число ?? '') : '',
              unit: judged.model.область && judged.model.область !== 'нет' ? judged.model.единица ?? '' : '',
              others: judged.model.другие_просьбы === 'да' || judged.model.другие_просьбы === 'нет' ? judged.model.другие_просьбы : '',
            };
          }
          ruled = judged.model
            ? enforce(judged.model, letterText, points, breaches, prior, changes, staff, letter.fromEmail, audiences, letter.fromName, audienceState.built, persons)
            : failedRuling(letterText, judged.error);
          if (judged.model) {
            const granted = letterHits(letter, authority, {
              area: named.area,
              value: Number(named.value),
              unit: named.unit,
              others: named.others !== 'нет',
            });
            if (granted?.kind === 'полномочие') ruled = rightRuling(granted);
          }
          if (!judged.model && changes.length) ruled = { ...ruled, summary: `Условия изменились: ${changeWords(changes)}. ${ruled.summary}` };
          if (steps) ruled = { ...ruled, context: [ruled.context, steps].filter(Boolean).join('\n') };
          if (changes.length && ruled.ask) await supersede(db, leaderId, key, letter.id, decisionRows);
        }
      }
      ruled = { ...ruled, draft: finishDraft(applyRevision(ruled.draft, ruled.category, edits), letterText, edits, inside) };

      if (ruled.ask) {
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
          originalDraft: '',
          pendingRule: '',
          createdAt: moment,
        });
        if (options.notify !== false) try {
          if (!leaderRow.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
          const card = staffFromVerdict({
            summary: ruled.summary || letter.subject,
            recommendation: ruled.recommendation,
            basis: ruled.basis,
            context: ruled.context,
            risks: ruled.risks,
            ifNot: ruled.ifNot,
          });
          if (!card) throw new Error('Карточка без вывода и рекомендации');
          await sendDecisionCard(
            cardText({
              who: `${letter.fromName}: ${letter.subject}`,
              ...card,
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
          originalDraft: '',
          pendingRule: '',
          createdAt: moment,
        });
      } else if (ruled.send) {
        // Ответ отправителю или пересылка сотруднику, чьё это дело.
        const target = ruled.kind === 'делегировать' && ruled.forwardTo ? ruled.forwardTo : { name: letter.fromName, email: letter.fromEmail };
        if (ruled.kind === 'делегировать') await deliverForward(target, letter, ruled.draft);
        else await deliverReply(letter.fromName, letter.fromEmail, letter.subject, ruled.draft);
        const row = {
          id: letter.id,
          leaderId,
          chainKey: key,
          status: 'исполнено',
          summary: ruled.summary,
          draft: ruled.draft,
          replyTo: target.email,
          replyName: target.name,
          subject: letter.subject,
          awaitingEdit: false,
          originalDraft: '',
          pendingRule: '',
          createdAt: moment,
        };
        await db.insert(decisions).values(row);
        decisionRows.push(row);
        await recordAct(db, {
          leaderId,
          subject: letter.subject,
          action: ruled.kind === 'делегировать' ? 'передал сотрудник' : 'ответил сам',
          result: ruled.summary,
          original: '',
          approved: ruled.draft,
          auto: true,
          refId: letter.id,
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
        id: `v-${letter.id}`.slice(0, 120),
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
        authorityArea: named.area,
        authorityValue: named.value,
        authorityUnit: named.unit,
        authorityOthers: named.others,
        createdAt: new Date(),
      }).onConflictDoNothing();
      verdictRows.push({ chainKey: key, kind: ruled.kind, createdAt: new Date() });
      pastMail.push({ fromEmail: letter.fromEmail, subject: letter.subject, received: stamp, kind: ruled.kind });
      seen.add(letter.messageId);
      lines.push(`${letter.id}: ${ruled.kind}${ruled.forwardTo ? ` → ${ruled.forwardTo.name}` : ''}`);
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

// Заново разбирает только ждущие письма. Решённые не меняет, ответ не отправляет, карточку в Telegram не шлёт.
export async function rejudgeWaiting(db: Db, leaderId: string): Promise<{ id: string; kind: string; ask: boolean; gap: string; area: string; draft: string }[]> {
  const [leaderRow] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leaderRow) throw new Error('Руководитель не найден');
  const waiting = await db.select().from(decisions).where(and(eq(decisions.leaderId, leaderId), eq(decisions.status, 'ждёт')));
  const persons = await db.select().from(people).where(eq(people.leaderId, leaderId));
  const kpiRows = await db.select().from(kpis).where(eq(kpis.leaderId, leaderId));
  const authRows = await db.select().from(authorities).where(eq(authorities.leaderId, leaderId));
  const taskRows = await db.select().from(tasks).where(eq(tasks.leaderId, leaderId));
  const revisionRows = await db.select().from(revisions).where(eq(revisions.leaderId, leaderId)).orderBy(asc(revisions.createdAt));
  const edits = mailRevisions(revisionRows.map((row) => ({ category: row.category, area: row.area, instead: row.instead })));
  const actRows = await db.select().from(leaderActs).where(eq(leaderActs.leaderId, leaderId)).orderBy(asc(leaderActs.at));
  const history = await readHistory(`data/${leaderId}`).catch(() => []);
  const catalog = await db.select().from(emails).where(eq(emails.leaderId, leaderId));
  const inbox = await db.select().from(mailIn).where(eq(mailIn.leaderId, leaderId));
  const authority = await listFlowRules(db, leaderId);
  const audienceState = await loadAudienceState(db, leaderId);
  const staff = persons.filter((row) => row.role === 'подчинённый').map((row) => ({ name: row.name, email: row.email }));
  const peopleList = persons.filter((row) => row.role === 'подчинённый').map((row) => ({ name: row.name, position: row.position, zone: row.zone }));
  const pastMail = inbox.map((row) => ({ fromEmail: row.fromEmail, subject: row.subject, received: row.received, kind: null as string | null }));
  const out: { id: string; kind: string; ask: boolean; gap: string; area: string; draft: string }[] = [];
  for (const decision of waiting) {
    const letter = catalog.find((row) => row.externalId === decision.id) ?? inbox.find((row) => row.syntheticId === decision.id || row.messageId === decision.id);
    if (!letter) {
      out.push({ id: decision.id, kind: 'нет письма', ask: true, gap: '', area: '', draft: '' });
      continue;
    }
    const person = persons.find((row) => personAddresses(row).includes(letter.fromEmail.toLowerCase()));
    const inside = Boolean(person && person.role !== 'руководитель');
    const letterText = `${letter.subject}\n${letter.body}`;
    const ownAuth = person ? authRows.filter((row) => row.personId === person.externalId) : [];
    const points = confirmationPoints(leaderRow.profile);
    const limits = ownAuth.map((row) => ({ area: row.area, limit: row.limitValue, unit: row.unit }));
    const areas = limits.flatMap((row) => {
      const limit = Number(String(row.limit).replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(limit) && normalizeUnit(row.unit) ? [row.area] : [];
    });
    const ctx = inside && person
      ? k2Context(person, { authorities: authRows, kpi: kpiRows, tasks: taskRows, history, mail: pastMail, revisions: edits, people: peopleList })
      : externalContext({ name: letter.fromName, email: letter.fromEmail }, { mail: pastMail, revisions: edits, people: peopleList });
    const agent = inside ? 'k2' : 'mail_ext';
    let named = { area: '', value: '', unit: '', others: '' };
    let ruled: Ruled;
    try {
      const judged = await withLlmScope(
        { agent, leaderId, operationId: `${agent}:rejudge:${decision.id}`, title: letter.subject.slice(0, 180) || 'Разбор письма' },
        () => judgeWithTools({
          purpose: `${agent}:rejudge:${decision.id}`,
          profile: leaderRow.profile,
          subject: letter.subject,
          body: letter.body,
          ctx,
          hints: [ruleHint(edits), rightsHint(authority, letter.fromEmail), exampleBlock(letterText, actRows)].filter(Boolean).join('\n\n'),
        }),
      );
      const breaches = breachesFromAnswer({ area: judged.verdict.область ?? 'нет', value: judged.verdict.число ?? 0, unit: judged.verdict.единица ?? '' }, limits);
      named = {
        area: judged.verdict.область && judged.verdict.область !== 'нет' ? judged.verdict.область : '',
        value: judged.verdict.область && judged.verdict.область !== 'нет' ? String(judged.verdict.число ?? '') : '',
        unit: judged.verdict.область && judged.verdict.область !== 'нет' ? judged.verdict.единица ?? '' : '',
        others: judged.verdict.другие_просьбы === 'да' || judged.verdict.другие_просьбы === 'нет' ? judged.verdict.другие_просьбы : '',
      };
      ruled = enforce(judged.verdict, letterText, points, breaches, null, [], staff, letter.fromEmail, audienceState.audiences, letter.fromName, audienceState.built, persons);
      const granted = letterHits({ fromEmail: letter.fromEmail, subject: letter.subject, body: letter.body }, authority, {
        area: named.area,
        value: Number(named.value),
        unit: named.unit,
        others: named.others !== 'нет',
      });
      if (granted?.kind === 'полномочие') ruled = rightRuling(granted);
      if (judged.steps.length) ruled = { ...ruled, context: [ruled.context, stepsWords(judged.steps)].filter(Boolean).join('\n') };
    } catch (error) {
      ruled = failedRuling(letterText, error instanceof Error ? error.message : String(error));
    }
    ruled = { ...ruled, draft: finishDraft(applyRevision(ruled.draft, ruled.category, edits), letterText, edits, inside) };
    if (ruled.ask) {
      await db.update(decisions).set({ summary: ruled.summary, draft: ruled.draft }).where(and(eq(decisions.id, decision.id), eq(decisions.leaderId, leaderId), eq(decisions.status, 'ждёт')));
      await db.update(verdicts).set({
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
        authorityArea: named.area,
        authorityValue: named.value,
        authorityUnit: named.unit,
        authorityOthers: named.others,
      }).where(and(eq(verdicts.leaderId, leaderId), eq(verdicts.id, `v-${decision.id}`.slice(0, 120))));
    }
    out.push({ id: decision.id, kind: ruled.kind, ask: ruled.ask, gap: draftGap(ruled.draft), area: named.area, draft: ruled.draft });
  }
  return out;
}

// Руководитель не в «Кому», а в копии (или его вовсе нет среди получателей): письмо для сведения, ответа от него не ждут.
export function copyRuling(inCopy: boolean): Ruled {
  return {
    kind: 'в_сводку',
    category: 'иное',
    summary: inCopy ? 'Вы в копии: письмо для сведения' : 'Письмо адресовано не вам: для сведения',
    draft: '',
    basis: inCopy ? 'Руководитель в копии, а не в адресатах — от него ответ не требуется' : 'Руководителя нет среди адресатов — от него ответ не требуется',
    context: '',
    recommendation: '',
    risks: '',
    ifNot: '',
    authorityOffer: '',
    ask: false,
    send: false,
  };
}

// Последний разбор переписки без решения руководителя (в сводку, без ответа): повтор с теми же условиями не разбирается заново.
function chainSeen(rows: { chainKey: string; kind: string; createdAt: Date }[], key: string): string | null {
  const chain = rows.filter((row) => row.chainKey === key && row.kind !== 'повтор').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return chain[0]?.kind ?? null;
}

function repeatRuling(kind: string): Ruled {
  return {
    kind: 'повтор',
    category: 'иное',
    summary: `Повтор. Прежнее письмо этой переписки: ${actionWords(kind)}`,
    draft: '',
    basis: 'По этой переписке уже был разбор, условия не изменились',
    context: '',
    recommendation: '',
    risks: '',
    ifNot: '',
    authorityOffer: '',
    ask: false,
    send: false,
  };
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
    return 'Напишите правку. По умолчанию она только для этого письма. «Запомнить» оставит правило для следующих.';
  }
  if (action === 'once' || action === 'keep') {
    const remembered = ruleFromChoice(decision.pendingRule, action);
    if (action === 'keep' && !remembered) return 'Сначала напишите правку.';
    if (remembered) {
      await db.insert(revisions).values({
        id: randomUUID(),
        leaderId,
        category: 'письма',
        area: 'письма',
        instead: remembered,
        createdAt: new Date(),
      });
    }
    await db.update(decisions).set({ pendingRule: '' }).where(eq(decisions.id, decision.id));
    return remembered ? 'Правило записано в профиль. Черновик ниже можно утвердить.' : 'Только это письмо. Правило не создано.';
  }
  if (action === 'approve') {
    const draft = decision.draft.replace(/\n*По вашей правке:[\s\S]*$/u, '').trim();
    const blocked = approvalBlock(draft);
    if (blocked) return blocked;
    await deliverReply(decision.replyName, decision.replyTo, decision.subject, draft);
    await db.update(decisions).set({ status: 'исполнено', draft, pendingRule: '' }).where(eq(decisions.id, decision.id));
    await recordAct(db, {
      leaderId,
      subject: decision.subject,
      action: 'утвердил',
      result: 'Ответ отправлен',
      original: decision.originalDraft || draft,
      approved: draft,
      auto: false,
      refId: decision.id,
    });
    return 'Ответ отправлен';
  }
  const status = action === 'reject' ? 'отклонено' : action === 'defer' ? 'отложено' : '';
  if (!status) return 'Неизвестная кнопка';
  await db.update(decisions).set({ status }).where(eq(decisions.id, decision.id));
  await recordAct(db, {
    leaderId,
    subject: decision.subject,
    action: status === 'отклонено' ? 'отклонил' : 'отложил',
    result: status === 'отклонено' ? 'Отклонено' : 'Отложено',
    original: decision.originalDraft || decision.draft,
    approved: '',
    auto: false,
    refId: decision.id,
  });
  return status === 'отклонено' ? 'Отклонено' : 'Отложено';
}

async function sourceLetter(db: Db, leaderId: string, id: string, subject: string, summary: string): Promise<string> {
  const [live] = await db.select().from(mailIn).where(and(eq(mailIn.leaderId, leaderId), eq(mailIn.messageId, id))).limit(1);
  if (live?.body) return `${live.subject}\n${live.body}`;
  const [synth] = await db.select().from(mailIn).where(and(eq(mailIn.leaderId, leaderId), eq(mailIn.syntheticId, id))).limit(1);
  if (synth?.body) return `${synth.subject}\n${synth.body}`;
  const [catalog] = await db.select().from(emails).where(and(eq(emails.leaderId, leaderId), eq(emails.externalId, id))).limit(1);
  if (catalog?.body) return `${catalog.subject}\n${catalog.body}`;
  return `${subject}\n${summary}`;
}

async function recordAct(
  db: Db,
  input: { leaderId: string; subject: string; action: string; result: string; original: string; approved: string; auto: boolean; refId: string },
) {
  await writeLeaderAct(db, input);
}

const LETTER_EDIT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
};

async function rewriteWithModel(leaderId: string, draft: string, instruction: string): Promise<string> {
  const result = await withLlmScope(
    { agent: 'k2', leaderId, operationId: `letter-edit:${leaderId}:${Date.now()}`, title: 'Правка письма' },
    () =>
      callJson<{ text: string }>({
        purpose: `letter-edit:${leaderId}`,
        system: [
          'Ты правишь черновик письма по просьбе руководителя.',
          'Верни готовый текст письма.',
          'Сохрани факты: имена, даты, сроки, суммы, проценты и что именно обещано.',
          'Не заменяй письмо текстом просьбы.',
          'Не пиши фразу «По вашей правке».',
        ].join(' '),
        user: `Черновик:\n${draft}\n\nПросьба руководителя:\n${instruction}`,
        schemaName: 'letter_edit',
        schema: LETTER_EDIT_SCHEMA,
      }),
  );
  return result.data.text ?? '';
}

export async function saveEditText(db: Db, chatId: string, text: string): Promise<{ id: string; text: string } | null> {
  const instead = text.trim();
  if (instead.length < 3) return null;
  const [leader] = await db.select().from(leaders).where(eq(leaders.telegramChatId, chatId)).limit(1);
  if (!leader) return null;
  return saveLeaderEdit(db, leader.id, instead);
}

export async function saveLeaderEdit(db: Db, leaderId: string, text: string, decisionId = ''): Promise<{ id: string; text: string; draft: string; changed: boolean } | null> {
  const instead = text.trim();
  if (instead.length < 3) return null;
  const [decision] = decisionId
    ? await db.select().from(decisions).where(and(eq(decisions.id, decisionId), eq(decisions.leaderId, leaderId))).limit(1)
    : await db.select().from(decisions).where(and(eq(decisions.leaderId, leaderId), eq(decisions.awaitingEdit, true))).limit(1);
  if (!decision || decision.status !== 'ждёт') return null;
  const letterText = await sourceLetter(db, leaderId, decision.id, decision.subject, decision.summary);
  let proposed = rewriteLetter(decision.draft, instead, letterText);
  if (proposed === null) {
    try {
      proposed = await rewriteWithModel(leaderId, decision.draft, instead);
    } catch (err) {
      console.error('Правка письма не разобрана', decision.id, err instanceof Error ? err.message : err);
      proposed = null;
    }
  }
  const draft = proposed === null ? null : acceptRewrite(decision.draft, instead, proposed);
  await db
    .update(decisions)
    .set({
      ...(draft ? { draft } : {}),
      originalDraft: decision.originalDraft || decision.draft,
      pendingRule: instead,
      awaitingEdit: false,
    })
    .where(eq(decisions.id, decision.id));
  if (!draft) {
    const asked = proposed?.trim().toLowerCase() === instead.toLowerCase();
    const untouched = proposed !== null && proposed.trim() === decision.draft.trim();
    const why = asked ? 'просьба не подставлена вместо письма' : untouched || proposed === null ? 'менять было нечего' : 'правка не сохранила факты письма';
    return {
      id: decision.id,
      draft: decision.draft,
      changed: false,
      text: `Черновик не изменился: ${why}. «Запомнить» запишет правило, «Только сейчас» — нет.`,
    };
  }
  await recordAct(db, {
    leaderId,
    subject: decision.subject,
    action: 'поправил',
    result: instead,
    original: decision.originalDraft || decision.draft,
    approved: draft,
    auto: false,
    refId: decision.id,
  });
  return {
    id: decision.id,
    draft,
    changed: true,
    text: `Черновик обновлён. «Только сейчас» — правило не создаётся. «Запомнить» — для следующих писем.\n\n${draft}`,
  };
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
    `Кому: ${name} <${email}>\nСтенд отправляет письма помощника в тестовый ящик, получатель назван выше.\n\n${draft}`,
  );
}

// Пересылка сотруднику, чьё это дело: записка помощника и исходное письмо.
export async function deliverForward(
  to: { name: string; email: string },
  letter: { fromName: string; fromEmail: string; subject: string; body: string },
  note: string,
) {
  const cfg = mailConfig();
  if (!cfg) throw new Error('Яндекс Почта не настроена');
  await sendMail(
    cfg.user,
    `Fwd: ${letter.subject}`,
    [
      `Кому: ${to.name} <${to.email}>`,
      'Стенд отправляет письма помощника в тестовый ящик, получатель назван выше.',
      '',
      note,
      '',
      '---------- Пересланное письмо ----------',
      `От: ${letter.fromName} <${letter.fromEmail}>`,
      `Тема: ${letter.subject}`,
      '',
      letter.body,
    ].join('\n'),
  );
}

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

function actionWords(action: string): string {
  if (action === 'нужен_руководитель' || action === 'спросить_руководителя') return 'передано руководителю';
  if (action === 'вернуть' || action === 'авто') return 'помощник ответил сам';
  if (action === 'делегировать') return 'передано сотруднику';
  if (action === 'в_сводку') return 'в сводку';
  if (action === 'игнорировать') return 'без ответа';
  return action;
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
