// Сборка утра и матрицы из базы. Три дела выбирает модель, остальное считает код.
import { eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { decisions, focusPlans, freedSlots, leaders, meetings, seriesKind, tasks, verdicts } from '../db/schema.ts';
import { calendarAfter } from './free-time.ts';
import { departmentForLeader } from './k1.ts';
import { chooseFocus, classifySeries, type Candidate, type FocusPlan } from './conductor.ts';
import { adviceTitle, departmentMatrix, goalMinutes, overdueLines, overdueTasks, ownWeekTasks, renderMorning } from './focus.ts';
import { withLlmScope } from '../llm.ts';
import { textSignals } from './k2.ts';
import { sendMessage } from '../telegram.ts';
import { latestProtocol } from './protocol.ts';
import { clockFor, dateWords, moscowDay, shiftDay, waitedDays } from './scene.ts';

export async function focusForLeader(db: Db, leaderId: string, leaderName: string) {
  const scene = await sceneFor(db, leaderId, leaderName);
  const stored = await db.select().from(focusPlans).where(eq(focusPlans.leaderId, leaderId)).limit(1);
  const plan = stored[0]?.plan as { text?: string } | undefined;
  return { matrix: scene.matrix, share: scene.share, text: plan?.text || scene.draft, overdue: scene.overdue };
}

export async function sendFocus(db: Db, leaderId: string) {
  const [leader] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader) throw new Error('Руководитель не найден');
  if (!leader.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
  const scene = await sceneFor(db, leaderId, leader.name);
  const plan = await withLlmScope(
    { agent: 'k4', leaderId, operationId: `k4:${leaderId}:${Date.now()}`, title: 'Утреннее сообщение' },
    () => chooseFocus({ purpose: `k4:${leaderId}`, profile: leader.profile, candidates: scene.candidates, names: scene.names }),
  );
  await classifyNewSeries(db, leaderId, leader.profile);
  const protocol = await latestProtocol(db, leaderId);
  const text = renderMorning({ ...scene.morning, plan: plan.today, openItems: protocol?.open ?? [] });
  await db
    .insert(focusPlans)
    .values({ leaderId, plan: { text, today: plan.today, later: plan.later }, createdAt: new Date() })
    .onConflictDoUpdate({ target: focusPlans.leaderId, set: { plan: { text, today: plan.today, later: plan.later }, createdAt: new Date() } });
  await sendMessage(escapeHtml(text), leader.telegramChatId);
  return { matrix: scene.matrix, share: scene.share, text };
}

export async function sendFocusAll(db: Db) {
  const rows = await db.select().from(leaders).where(isNotNull(leaders.telegramChatId));
  for (const leader of rows) {
    if (!leader.telegramChatId) continue;
    await sendFocus(db, leader.id);
  }
}

async function sceneFor(db: Db, leaderId: string, leaderName: string) {
  const [department, taskRows, decisionRows, verdictRows, storedMeetings, freedRows] = await Promise.all([
    departmentForLeader(db, leaderId),
    db.select().from(tasks).where(eq(tasks.leaderId, leaderId)),
    db.select().from(decisions).where(eq(decisions.leaderId, leaderId)),
    db.select({ id: verdicts.id, kind: verdicts.kind }).from(verdicts).where(eq(verdicts.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
    db.select().from(freedSlots).where(eq(freedSlots.leaderId, leaderId)),
  ]);
  // Календарь после отпущенных серий: на месте встречи — блок приоритета руководителя.
  const meetingRows = calendarAfter(storedMeetings, freedRows);
  const matrix = departmentMatrix(
    department.people.map((person) => ({
      name: person.name,
      emails: person.emails,
      lagging: person.kpis.some((kpi) => kpi.weeks.some((week) => week.status === 'отстаёт')),
    })),
  );
  const clock = clockFor(leaderId);
  const today = clock.today;
  const ownTasks = taskRows.filter((row) => row.ownerName === leaderName && row.status !== 'сделана' && row.status !== 'закрыта');
  // Задачи руководителя со сроком в ближайшую неделю идут отдельным блоком всегда, поэтому в выбор трёх дел не входят.
  const ownWeek = ownWeekTasks(ownTasks, today);
  const weekIds = new Set(ownWeek.map((row) => row.externalId));
  const overdue = overdueTasks(
    taskRows
      .filter((row) => row.ownerName !== leaderName)
      .map((row) => ({ title: row.title, owner: row.ownerName, dueOn: row.dueOn, status: row.status })),
    today,
  );
  // Решения, которые ждут руководителя, идут в сообщение отдельным блоком, поэтому в выбор трёх дел не входят.
  const waiting = decisionRows
    .filter((row) => row.status === 'ждёт')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({ who: row.replyName, what: row.subject || row.summary, days: waitedDays(row.createdAt, clock.now) }));
  // Вернул сам: помощник ответил человеку без руководителя на этой неделе сцены.
  const returnedIds = new Set(verdictRows.filter((row) => row.kind === 'вернуть').map((row) => row.id));
  const monday = weekStart(today);
  const returned = decisionRows
    .filter((row) => row.status === 'исполнено' && returnedIds.has(`v-${row.id}`))
    .filter((row) => {
      const day = moscowDay(row.createdAt);
      return day >= monday && day <= today;
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({ who: row.replyName, what: row.subject || row.summary }));
  const goalOf = (name: string) => department.people.find((person) => person.name === name)?.goal ?? '';
  const candidates: Candidate[] = [
    ...ownTasks.filter((row) => !weekIds.has(row.externalId)).map((row) => ({
      id: `task:${row.externalId}`,
      kind: 'задача',
      title: row.title,
      detail: `срок ${dateWords(row.dueOn)}, статус ${row.status}`,
      goal: '',
    })),
    ...matrix.flatMap((row) => {
      const title = adviceTitle(row);
      if (!title) return [];
      return [{ id: `matrix:${row.name}`, kind: 'сотрудник', title, detail: row.basis, goal: goalOf(row.name), person: row.name }];
    }),
  ];
  const share = goalMinutes(
    meetingRows.map((row) => ({ minutes: row.minutes, summary: row.summary, goal: row.goal })),
    department.people.flatMap((person) => [person.goal, person.leaderGoal]),
  );
  const morning = {
    today,
    waiting,
    ownWeek: ownWeek.map((row) => ({ title: row.title, dueOn: row.dueOn })),
    returned,
    overdue,
    todayMeetings: titlesOn(meetingRows, today),
    share,
  };
  return {
    matrix,
    share,
    candidates,
    names: department.people.map((person) => person.name),
    morning,
    draft: renderMorning({ ...morning, plan: null, openItems: [] }),
    overdue: overdueLines(overdue),
  };
}

// Понедельник недели сцены.
function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function classifyNewSeries(db: Db, leaderId: string, profile = '') {
  const [known, rows] = await Promise.all([
    db.select().from(seriesKind).where(eq(seriesKind.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
  ]);
  const seen = new Set(known.filter((row) => row.category).map((row) => row.seriesKey));
  const byTitle = new Map<string, string[]>();
  for (const row of rows) {
    if (seen.has(row.summary) || byTitle.has(row.summary)) continue;
    byTitle.set(row.summary, attendeeNames(row.attendees));
  }
  const fresh = [...byTitle.entries()].map(([title, attendees]) => ({ title, attendees }));
  const classified = await withLlmScope(
    { agent: 'k15', leaderId, operationId: `k15:${leaderId}:${Date.now()}`, title: 'Вид встреч' },
    () => classifySeries({ purpose: `k4:series:${leaderId}`, series: fresh, profile }),
  );
  for (const row of classified) {
    const category = seriesCategory(row.title, row.category);
    await db
      .insert(seriesKind)
      .values({ leaderId, seriesKey: row.title, kind: row.kind, category })
      .onConflictDoUpdate({ target: [seriesKind.leaderId, seriesKind.seriesKey], set: { kind: row.kind, category } });
  }
}

function attendeeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === 'object' && 'name' in item && typeof item.name === 'string' ? item.name : ''))
    .filter(Boolean);
}

function titlesOn(rows: { startsAt: string; summary: string }[], day: string): string[] {
  return [...new Set(rows.filter((row) => meetingDay(row.startsAt) === day).map((row) => row.summary))];
}

function meetingDay(startsAt: string): string {
  const digits = startsAt.replace(/\D/g, '');
  if (digits.length < 8) return '';
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export type { FocusPlan };

// Категорию встречи предлагает модель, код перепроверяет по признакам в названии: N1 в названии сильнее «иное».
export function seriesCategory(title: string, model: string): string {
  const signal = textSignals(title).category ?? titleSignal(title);
  if (signal && model === 'иное') return signal;
  return model || signal || 'иное';
}

function titleSignal(title: string): string | null {
  if (/бюджет|скидк|закупк/i.test(title)) return 'деньги';
  if (/найм|интервью|кандидат|оффер|отпуск|увольн/i.test(title)) return 'кадры';
  if (/жалоб|договор|(^|[^А-Яа-яЁё])КП([^А-Яа-яЁё]|$)|коммерческ|гарант/i.test(title)) return 'обязательства_клиентам';
  return null;
}
