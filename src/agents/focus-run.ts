// Сборка утра и матрицы. Задачи и встречи — из Трекера и календаря «Стенд» (T65), остальное — из базы. Три дела выбирает модель, остальное считает код.
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { decisions, focusPlans, freedSlots, leaders, meetings, revisions, seriesKind, tasks, verdicts } from '../db/schema.ts';
import { calendarAfter } from './free-time.ts';
import { departmentForLeader } from './k1.ts';
import { chooseFocus, classifySeries, GOAL_KINDS, type Candidate, type FocusPlan } from './conductor.ts';
import { adviceTitle, departmentMatrix, goalMinutes, isLeaderTask, morningHtml, overdueLines, overdueTasks, ownWeekTasks, renderMorning } from './focus.ts';
import { combineMorning, parseMorningStored, type MorningShape } from './morning.ts';
import { withLlmScope } from '../llm.ts';
import { canonicalCategory, confirmationPoints } from './confirm.ts';
import { sendMessage } from '../telegram.ts';
import { morningQuestions } from './protocol-context.ts';
import { oneOnOneForDay } from './one-on-one.ts';
import { clockFor, dateWords, moscowDay, shiftDay, waitedDays } from './scene.ts';
import { liveSources, type LiveMeeting, type LiveTask } from './live-sources.ts';
import { sendTaskReminders } from './reminders.ts';

export async function focusForLeader(db: Db, leaderId: string, leaderName: string) {
  const morning = await morningShape(db, leaderId);
  const scene = await sceneFor(db, leaderId, leaderName, undefined, morning);
  const stored = await db.select().from(focusPlans).where(eq(focusPlans.leaderId, leaderId)).limit(1);
  const plan = stored[0]?.plan as { text?: string } | undefined;
  return { matrix: scene.matrix, share: scene.share, text: plan?.text || scene.draft, overdue: scene.overdue };
}

export async function sendFocus(db: Db, leaderId: string) {
  const [leader] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader) throw new Error('Руководитель не найден');
  if (!leader.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
  // Задачи и встречи — из Трекера и календаря; что не ответило — из базы, с пометкой в сообщении.
  const live = await liveSources(db, leaderId, leader.name);
  const morning = await morningShape(db, leaderId);
  // Вид новых серий — до подсчёта времени на цели: оно считается по видам встреч. Встреча, поставленная в календаре руками, — тоже серия.
  await classifyNewSeries(db, leaderId, leader.profile, false, (live.meetings ?? []).filter((row) => !row.goal).map((row) => row.summary));
  const scene = await sceneFor(db, leaderId, leader.name, live, morning);
  const plan = await withLlmScope(
    { agent: 'k4', leaderId, operationId: `k4:${leaderId}:${Date.now()}`, title: 'Утреннее сообщение' },
    () => chooseFocus({ purpose: `k4:${leaderId}`, profile: leader.profile, candidates: scene.candidates, names: scene.names, hint: morning?.focus }),
  );
  const questions = await morningQuestions(db, leaderId, scene.meetings, scene.morning.today, shiftDay(scene.morning.today, 1));
  let oneOnOne: { name: string; lines: { text: string; sources: { label: string; href: string }[] }[] }[] = [];
  try {
    oneOnOne = await oneOnOneForDay(db, leaderId, leader.name, scene.morning.today, live.meetings ?? scene.meetings, live.briefTasks ?? live.tasks);
  } catch (err) {
    console.error('Сводка к встрече один на один не собралась', err instanceof Error ? err.message : err);
  }
  const text = renderMorning({ ...scene.morning, plan: plan.today, questions, notes: live.notes, morning, oneOnOne });
  try {
    await sendTaskReminders(db, leaderId, leader.name, live.tasks, clockFor(leaderId).today);
  } catch (err) {
    console.error('Напоминания о сроках не отправлены', err instanceof Error ? err.message : err);
  }
  await db
    .insert(focusPlans)
    .values({ leaderId, plan: { text, today: plan.today, later: plan.later }, createdAt: new Date() })
    .onConflictDoUpdate({ target: focusPlans.leaderId, set: { plan: { text, today: plan.today, later: plan.later }, createdAt: new Date() } });
  await sendMessage(morningHtml(text), leader.telegramChatId);
  return { matrix: scene.matrix, share: scene.share, text };
}

export async function sendFocusAll(db: Db) {
  const rows = await db.select().from(leaders).where(isNotNull(leaders.telegramChatId));
  for (const leader of rows) {
    if (!leader.telegramChatId) continue;
    await sendFocus(db, leader.id);
  }
}

// live — задачи и встречи из Трекера и календаря; без него (кабинет) — из базы, чтобы страница не ждала внешние сервисы.
async function morningShape(db: Db, leaderId: string): Promise<MorningShape | null> {
  const rows = await db.select().from(revisions).where(and(eq(revisions.leaderId, leaderId), eq(revisions.area, 'утро')));
  const rules = rows.flatMap((row) => {
    const shape = parseMorningStored(row.understood);
    return shape ? [{ id: row.id, at: row.createdAt.toISOString(), text: row.instead, shape }] : [];
  });
  return combineMorning(rules).shape;
}

async function sceneFor(db: Db, leaderId: string, leaderName: string, live?: { tasks: LiveTask[] | null; meetings: LiveMeeting[] | null }, morningRule: MorningShape | null = null) {
  const [department, taskRows, decisionRows, verdictRows, storedMeetings, freedRows, kindRows] = await Promise.all([
    departmentForLeader(db, leaderId),
    db.select().from(tasks).where(eq(tasks.leaderId, leaderId)),
    db.select().from(decisions).where(eq(decisions.leaderId, leaderId)),
    db.select({ id: verdicts.id, kind: verdicts.kind }).from(verdicts).where(eq(verdicts.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
    db.select().from(freedSlots).where(eq(freedSlots.leaderId, leaderId)),
    db.select().from(seriesKind).where(eq(seriesKind.leaderId, leaderId)),
  ]);
  const kindOf = new Map(kindRows.map((row) => [row.seriesKey, row.kind]));
  // Календарь «Стенд» уже без отпущенных встреч и с блоками приоритета; в базе то же получается через calendarAfter.
  const meetingRows: { summary: string; startsAt: string; minutes: number; goal?: boolean }[] = live?.meetings ?? calendarAfter(storedMeetings, freedRows);
  const taskList: LiveTask[] =
    live?.tasks ?? taskRows.map((row) => ({ id: row.externalId, title: row.title, owner: row.ownerName, dueOn: row.dueOn, status: row.status }));
  const matrix = departmentMatrix(
    department.people.map((person) => ({
      name: person.name,
      emails: person.emails,
      lagging: person.kpis.some((kpi) => kpi.weeks.some((week) => week.status === 'отстаёт')),
    })),
  );
  const clock = clockFor(leaderId);
  const today = clock.today;
  const ownTasks = taskList.filter((row) => isLeaderTask(row.owner, leaderName) && row.status !== 'сделана' && row.status !== 'закрыта' && row.status !== 'отменена');
  // Задачи руководителя со сроком в ближайшую неделю идут отдельным блоком всегда, поэтому в выбор трёх дел не входят.
  // Поручение без исполнителя («не назван») видно руководителю, даже если срока нет.
  const ownWeek = [
    ...ownWeekTasks(ownTasks.filter((row) => row.owner === leaderName), today),
    ...ownTasks.filter((row) => row.owner === 'не назван'),
  ];
  const weekIds = new Set(ownWeek.map((row) => row.id));
  const overdue = overdueTasks(
    taskList.filter((row) => !isLeaderTask(row.owner, leaderName)).map((row) => ({ title: row.title, owner: row.owner, dueOn: row.dueOn, status: row.status })),
    today,
  );
  // Решения, которые ждут руководителя, идут в сообщение отдельным блоком, поэтому в выбор трёх дел не входят.
  const waiting = decisionRows
    .filter((row) => row.status === 'ждёт')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({ who: row.replyName, what: row.subject || row.summary, days: waitedDays(row.createdAt, clock.now) }));
  // Вернул сам: помощник ответил человеку без руководителя на этой неделе сцены.
  const returnedIds = new Set(verdictRows.filter((row) => row.kind === 'вернуть').map((row) => row.id));
  const forwardedIds = new Set(verdictRows.filter((row) => row.kind === 'делегировать').map((row) => row.id));
  const monday = weekStart(today);
  const returned = decisionRows
    .filter((row) => row.status === 'исполнено' && (returnedIds.has(`v-${row.id}`) || forwardedIds.has(`v-${row.id}`)))
    .filter((row) => {
      const day = moscowDay(row.createdAt);
      return day >= monday && day <= today;
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({ who: row.replyName, what: forwardedIds.has(`v-${row.id}`) ? `${row.subject || row.summary} (передал)` : row.subject || row.summary }));
  const goalOf = (name: string) => department.people.find((person) => person.name === name)?.goal ?? '';
  const candidates: Candidate[] = [
    ...ownTasks.filter((row) => !weekIds.has(row.id)).map((row) => ({
      id: `task:${row.id}`,
      kind: 'задача',
      title: row.title,
      detail: `${row.dueOn ? `срок ${dateWords(row.dueOn)}` : 'без срока'}, статус ${row.status}`,
      goal: '',
    })),
    ...matrix.flatMap((row) => {
      const title = adviceTitle(row);
      if (!title) return [];
      return [{ id: `matrix:${row.name}`, kind: 'сотрудник', title, detail: row.basis, goal: goalOf(row.name), person: row.name }];
    }),
  ];
  const share = goalMinutes(
    meetingRows.map((row) => ({ minutes: row.minutes, kind: kindOf.get(row.summary), goal: row.goal })),
    GOAL_KINDS,
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
    draft: renderMorning({ ...morning, plan: null, questions: [], notes: [], morning: morningRule }),
    meetings: meetingRows,
    overdue: overdueLines(overdue),
  };
}

// Понедельник недели сцены.
function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

// all: определить вид заново у всех серий — нужно, когда меняется список видов.
// extra — названия встреч из календаря «Стенд», которых может не быть в базе (поставлены руками).
export async function classifyNewSeries(db: Db, leaderId: string, profile = '', all = false, extra: string[] = []) {
  const [known, stored] = await Promise.all([
    db.select().from(seriesKind).where(eq(seriesKind.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
  ]);
  const rows = [...stored, ...extra.map((summary) => ({ summary, attendees: [] as unknown }))];
  const seen = new Set(all ? [] : known.filter((row) => row.category).map((row) => row.seriesKey));
  const byTitle = new Map<string, string[]>();
  for (const row of rows) {
    if (seen.has(row.summary) || byTitle.has(row.summary)) continue;
    byTitle.set(row.summary, attendeeNames(row.attendees));
  }
  const fresh = [...byTitle.entries()].map(([title, attendees]) => ({ title, attendees }));
  const classified = await withLlmScope(
    { agent: 'k15', leaderId, operationId: `k15:${leaderId}:${Date.now()}`, title: 'Тип встреч' },
    () => classifySeries({ purpose: `k4:series:${leaderId}`, series: fresh, profile }),
  );
  for (const row of classified) {
    const category = seriesCategory(row.category, confirmationPoints(profile));
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

// Встречи дня по времени: «10:00 Планёрка направления».
function titlesOn(rows: { startsAt: string; summary: string }[], day: string): string[] {
  const lines = rows
    .filter((row) => meetingDay(row.startsAt) === day)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((row) => {
      const time = /T(\d{2}):?(\d{2})/.exec(row.startsAt);
      return time ? `${time[1]}:${time[2]} ${row.summary}` : row.summary;
    });
  return [...new Set(lines)];
}

function meetingDay(startsAt: string): string {
  const digits = startsAt.replace(/\D/g, '');
  if (digits.length < 8) return '';
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export type { FocusPlan };

// Категорию встречи предлагает модель. Код оставляет её, только если это пункт профиля или «иное».
export function seriesCategory(model: string, points: string[]): string {
  return canonicalCategory(model, points);
}
