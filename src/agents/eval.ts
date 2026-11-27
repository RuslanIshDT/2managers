// Замер разбора почты на эталоне (T54). Каждое письмо — отдельно, тем же путём, что на стенде:
// подчинённый и руководитель руководителя — агент полномочий с инструментами и проверки кода,
// остальные — разбор писем не из отдела. Эталон (expected_action, category) в запрос модели не входит.
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, emailEtalon, emails, kpis, leaders, people, revisions, tasks } from '../db/schema.ts';
import { withLlmScope } from '../llm.ts';
import { forceMailAction, judgeMail } from './accuracy.ts';
import { readHistory } from './dependence.ts';
import { personAddresses } from './k1.ts';
import { discountLimit, enforce, failedRuling, leaderMustConfirm, type Ruled } from './k2.ts';
import { judgeWithTools, k2Context } from './k2-tools.ts';

export const LEADER_ACTION = 'спросить_руководителя';

export interface EvalRow {
  id: string;
  subject: string;
  senderRole: string;
  category: string;
  expected: string;
  route: 'k2' | 'mail';
  action: string;
  toLeader: boolean;
  tools: string[];
  error: string;
}

export interface EvalScore {
  total: number;
  correct: number;
  accuracy: number;
  needLeader: number;
  caught: number;
  recall: number;
  falseAlarms: number;
  precision: number;
  n1: number;
  n1Caught: number;
  missed: EvalRow[];
  alarms: EvalRow[];
  byRole: { role: string; total: number; correct: number }[];
  mailExact: { total: number; correct: number };
  errors: number;
  toolCalls: Record<string, number>;
}

const ratio = (a: number, b: number) => (b ? a / b : 1);

export function evalScore(rows: EvalRow[]): EvalScore {
  const need = rows.filter((row) => row.expected === LEADER_ACTION);
  const flagged = rows.filter((row) => row.toLeader);
  const n1 = rows.filter((row) => leaderMustConfirm(row.category));
  const correct = rows.filter((row) => row.toLeader === (row.expected === LEADER_ACTION));
  const roles = [...new Set(rows.map((row) => row.senderRole))].sort((a, b) => a.localeCompare(b, 'ru'));
  const mail = rows.filter((row) => row.route === 'mail');
  const toolCalls: Record<string, number> = {};
  for (const row of rows) for (const tool of row.tools) toolCalls[tool] = (toolCalls[tool] ?? 0) + 1;
  return {
    total: rows.length,
    correct: correct.length,
    accuracy: ratio(correct.length, rows.length),
    needLeader: need.length,
    caught: need.filter((row) => row.toLeader).length,
    recall: ratio(need.filter((row) => row.toLeader).length, need.length),
    falseAlarms: flagged.filter((row) => row.expected !== LEADER_ACTION).length,
    precision: ratio(flagged.filter((row) => row.expected === LEADER_ACTION).length, flagged.length),
    n1: n1.length,
    n1Caught: n1.filter((row) => row.toLeader).length,
    missed: need.filter((row) => !row.toLeader),
    alarms: flagged.filter((row) => row.expected !== LEADER_ACTION),
    byRole: roles.map((role) => {
      const group = rows.filter((row) => row.senderRole === role);
      return { role, total: group.length, correct: group.filter((row) => row.toLeader === (row.expected === LEADER_ACTION)).length };
    }),
    mailExact: { total: mail.length, correct: mail.filter((row) => row.action === row.expected).length },
    errors: rows.filter((row) => row.error).length,
    toolCalls,
  };
}

async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

export async function runEval(
  db: Db,
  leaderId: string,
  options: { concurrency?: number; only?: Set<string>; onRow?: (row: EvalRow) => void } = {},
): Promise<EvalRow[]> {
  const [leader] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader) throw new Error('Руководитель не найден');
  const [letterRows, etalonRows, persons, authRows, kpiRows, taskRows, revisionRows] = await Promise.all([
    db.select().from(emails).where(eq(emails.leaderId, leaderId)).orderBy(asc(emails.received)),
    db.select().from(emailEtalon).where(eq(emailEtalon.leaderId, leaderId)),
    db.select().from(people).where(eq(people.leaderId, leaderId)),
    db.select().from(authorities).where(eq(authorities.leaderId, leaderId)),
    db.select().from(kpis).where(eq(kpis.leaderId, leaderId)),
    db.select().from(tasks).where(eq(tasks.leaderId, leaderId)),
    db.select().from(revisions).where(eq(revisions.leaderId, leaderId)).orderBy(asc(revisions.createdAt)),
  ]);
  const history = await readHistory(`data/${leaderId}`).catch(() => []);
  const etalon = new Map(etalonRows.map((row) => [row.externalId, row]));
  const edits = revisionRows.map((row) => ({ category: row.category, instead: row.instead }));
  const letters = letterRows.filter((row) => etalon.has(row.externalId) && (!options.only || options.only.has(row.externalId)));

  return pool(letters, options.concurrency ?? 4, async (letter) => {
    const mark = etalon.get(letter.externalId)!;
    const person = persons.find((row) => personAddresses(row).includes(letter.fromEmail.toLowerCase()));
    const boss = person?.role === 'руководитель руководителя';
    const base = { id: letter.externalId, subject: letter.subject, senderRole: letter.senderRole, category: mark.category, expected: mark.expectedAction };
    let row: EvalRow;
    if (person && (person.role === 'подчинённый' || boss)) {
      // Прежние письма отправителя — только те, что пришли раньше этого.
      const earlier = letterRows
        .filter((other) => other.received < letter.received)
        .map((other) => ({ fromEmail: other.fromEmail, subject: other.subject, received: other.received, kind: null }));
      const ctx = k2Context(person, { authorities: authRows, kpi: kpiRows, tasks: taskRows, history, mail: earlier, revisions: edits });
      const limit = discountLimit(ctx.authorities.map((item) => ({ area: item.area, limit: item.limitValue })));
      const text = `${letter.subject}\n${letter.body}`;
      let ruled: Ruled;
      let tools: string[] = [];
      let error = '';
      try {
        const run = await withLlmScope(
          { agent: 'k2', leaderId, operationId: `eval:k2:${letter.externalId}:${Date.now()}`, title: `Замер: ${letter.subject}`.slice(0, 180) },
          () => judgeWithTools({ purpose: `eval:k2:${letter.externalId}`, profile: leader.profile, subject: letter.subject, body: letter.body, ctx }),
        );
        tools = run.steps.map((step) => step.tool);
        ruled = enforce(run.verdict, text, limit, null, boss);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        ruled = failedRuling(text, error, boss);
      }
      row = { ...base, route: 'k2', action: ruled.ask ? LEADER_ACTION : 'вернуть', toLeader: ruled.ask, tools, error };
    } else {
      const text = `От: ${letter.fromName}\nТема: ${letter.subject}\n${letter.body}`;
      let action: string = LEADER_ACTION;
      let error = '';
      try {
        const chosen = await withLlmScope(
          { agent: 'accuracy', leaderId, operationId: `eval:mail:${letter.externalId}:${Date.now()}`, title: `Замер: ${letter.subject}`.slice(0, 180) },
          () => judgeMail({ purpose: `eval:mail:${letter.externalId}`, profile: leader.profile, letter: text }),
        );
        action = forceMailAction(text, false, chosen).action;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      row = { ...base, route: 'mail', action, toLeader: action === LEADER_ACTION, tools: [], error };
    }
    options.onRow?.(row);
    return row;
  });
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

export function evalReport(score: EvalScore, meta: { model: string; at: string; costUsd: number; calls: number; minutes: number }): string {
  const lines = [
    `# Замер разбора почты на эталоне`,
    '',
    `Когда: ${meta.at}. Модель: ${meta.model}. Писем: ${score.total}, каждое отдельным разбором. Вызовов модели: ${meta.calls}, цена $${meta.costUsd.toFixed(4)}, время ${meta.minutes} мин.`,
    'Путь как на стенде: письма подчинённых и руководителя руководителя — агент полномочий с инструментами и проверки кода (N1, лимиты); остальные — разбор писем не из отдела. Эталон в запрос не входит. Без принятых правил потока и без прошлых решений по цепочке: каждое письмо как первое.',
    '',
    '## Главное: дошло ли письмо до руководителя, когда должно',
    '',
    `| Показатель | Значение |`,
    `|---|---|`,
    `| Совпало с эталоном «руководитель нужен / не нужен» | ${score.correct} из ${score.total}, ${pct(score.accuracy)} |`,
    `| Письма, которым нужен руководитель: дошли | ${score.caught} из ${score.needLeader}, ${pct(score.recall)} |`,
    `| Письма N1 (деньги, кадры, обязательства клиентам, руководство): дошли | ${score.n1Caught} из ${score.n1} |`,
    `| Лишние письма руководителю | ${score.falseAlarms}, точность ${pct(score.precision)} |`,
    `| Письма не из отдела: точное действие из пяти | ${score.mailExact.correct} из ${score.mailExact.total} |`,
    `| Сбои разбора | ${score.errors} |`,
    '',
    '## По отправителям',
    '',
    '| Отправитель | Совпало |',
    '|---|---|',
    ...score.byRole.map((row) => `| ${row.role} | ${row.correct} из ${row.total} |`),
    '',
    '## Пропущено: руководитель нужен, а письмо не дошло',
    '',
    ...(score.missed.length ? score.missed.map((row) => `- ${row.id} «${row.subject}» (${row.senderRole}, ${row.category}) → ${row.action}`) : ['Нет']),
    '',
    '## Лишнее: письмо дошло до руководителя без нужды',
    '',
    ...(score.alarms.length ? score.alarms.map((row) => `- ${row.id} «${row.subject}» (${row.senderRole}, эталон ${row.expected})${row.error ? `, сбой: ${row.error.slice(0, 120)}` : ''}`) : ['Нет']),
    '',
    '## Какие инструменты выбирал агент полномочий',
    '',
    ...(Object.keys(score.toolCalls).length
      ? Object.entries(score.toolCalls)
          .sort((a, b) => b[1] - a[1])
          .map(([tool, n]) => `- ${tool}: ${n}`)
      : ['Инструменты не вызывались']),
    '',
  ];
  return lines.join('\n');
}
