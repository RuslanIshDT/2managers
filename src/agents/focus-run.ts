// Сборка утра и матрицы из базы. Три дела выбирает модель, остальное считает код.
import { eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { decisions, focusPlans, leaders, meetings, seriesKind, tasks } from '../db/schema.ts';
import { departmentForLeader } from './k1.ts';
import { chooseFocus, classifySeries, renderPlan, type Candidate, type FocusPlan } from './conductor.ts';
import { departmentMatrix, goalMinutes, morningLines } from './focus.ts';
import { sendMessage } from '../telegram.ts';
import { latestProtocol, morningOpenItems } from './protocol.ts';

export async function focusForLeader(db: Db, leaderId: string, leaderName: string) {
  const scene = await sceneFor(db, leaderId, leaderName);
  const stored = await db.select().from(focusPlans).where(eq(focusPlans.leaderId, leaderId)).limit(1);
  const plan = stored[0]?.plan as { text?: string } | undefined;
  return { matrix: scene.matrix, share: scene.share, text: plan?.text || scene.draft };
}

export async function sendFocus(db: Db, leaderId: string) {
  const [leader] = await db.select().from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader) throw new Error('Руководитель не найден');
  if (!leader.telegramChatId) throw new Error('Telegram-чат руководителя не привязан');
  const scene = await sceneFor(db, leaderId, leader.name);
  const plan = await chooseFocus({ purpose: `k4:${leaderId}`, profile: leader.profile, candidates: scene.candidates });
  await classifyNewSeries(db, leaderId);
  const text = renderPlan({
    plan,
    yesterday: scene.yesterday,
    todayMeetings: scene.todayMeetings,
    matrix: scene.matrix.map((row) => `— ${row.name}: ${row.basis}`),
    share: `Календарь на цели: ${scene.share.percent}% (${scene.share.onGoal} из ${scene.share.total} мин).`,
  });
  await db
    .insert(focusPlans)
    .values({ leaderId, plan: { text, today: plan.today, later: plan.later }, createdAt: new Date() })
    .onConflictDoUpdate({ target: focusPlans.leaderId, set: { plan: { text, today: plan.today, later: plan.later }, createdAt: new Date() } });
  const protocol = await latestProtocol(db, leaderId);
  await sendMessage(`${text}${protocol ? morningOpenItems(protocol.open) : ''}`, leader.telegramChatId);
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
  const [department, taskRows, decisionRows, meetingRows] = await Promise.all([
    departmentForLeader(db, leaderId),
    db.select().from(tasks).where(eq(tasks.leaderId, leaderId)),
    db.select().from(decisions).where(eq(decisions.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
  ]);
  const matrix = departmentMatrix(
    department.people.map((person) => ({
      name: person.name,
      emails: person.emails,
      lagging: person.kpis.some((kpi) => kpi.weeks.some((week) => week.status === 'отстаёт')),
    })),
  );
  const ownTasks = taskRows.filter((row) => row.ownerName === leaderName);
  const waiting = decisionRows.filter((row) => row.status === 'ждёт');
  const candidates: Candidate[] = [
    ...ownTasks.map((row) => ({
      id: `task:${row.externalId}`,
      kind: 'задача',
      title: row.title,
      detail: `срок ${row.dueOn}, статус ${row.status}`,
      goal: '',
    })),
    ...waiting.map((row) => ({
      id: `wait:${row.id}`,
      kind: 'решение',
      title: `${row.replyName}: ${row.summary}`,
      detail: `ждёт ${waitedDays(row.createdAt)} дн.`,
      goal: '',
    })),
    ...department.people
      .filter((person) => person.kpis.some((kpi) => kpi.weeks.some((week) => week.status === 'отстаёт')))
      .map((person) => ({
        id: `kpi:${person.id}`,
        kind: 'kpi',
        title: `KPI отстаёт: ${person.name}`,
        detail: person.goal,
        goal: person.goal,
      })),
    ...matrix.map((row) => ({
      id: `matrix:${row.name}`,
      kind: 'матрица',
      title: `${row.name}: ${row.basis}`,
      detail: row.basis,
      goal: department.people.find((person) => person.name === row.name)?.goal ?? '',
    })),
  ];
  const today = moscowDay(new Date());
  const yesterday = shiftDay(today, -1);
  const share = goalMinutes(
    meetingRows.map((row) => ({ minutes: row.minutes, summary: row.summary })),
    department.people.flatMap((person) => [person.goal, person.leaderGoal]),
  );
  const draft = [
    ...morningLines({
      tasks: ownTasks.map((row) => ({ title: row.title, dueOn: row.dueOn })),
      waiting: waiting.map((row) => ({ who: row.replyName, summary: row.summary })),
      quiet: matrix.filter((row) => row.quiet).map((row) => row.name),
    }),
    '',
    'Три дела модель выберет по кнопке «Прислать сейчас».',
    '',
    'Матрица отдела:',
    ...matrix.map((row) => `— ${row.name}: ${row.basis}`),
    '',
    `Календарь на цели: ${share.percent}% (${share.onGoal} из ${share.total} мин).`,
  ].join('\n');
  return {
    matrix,
    share,
    candidates,
    draft,
    yesterday: titlesOn(meetingRows, yesterday),
    todayMeetings: titlesOn(meetingRows, today),
  };
}

async function classifyNewSeries(db: Db, leaderId: string) {
  const [known, rows] = await Promise.all([
    db.select().from(seriesKind).where(eq(seriesKind.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
  ]);
  const seen = new Set(known.map((row) => row.seriesKey));
  const byTitle = new Map<string, string[]>();
  for (const row of rows) {
    if (seen.has(row.summary) || byTitle.has(row.summary)) continue;
    byTitle.set(row.summary, attendeeNames(row.attendees));
  }
  const fresh = [...byTitle.entries()].map(([title, attendees]) => ({ title, attendees }));
  const classified = await classifySeries({ purpose: `k4:series:${leaderId}`, series: fresh });
  if (!classified.length) return;
  await db.insert(seriesKind).values(classified.map((row) => ({ leaderId, seriesKey: row.title, kind: row.kind }))).onConflictDoNothing();
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

function moscowDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + delta));
  return next.toISOString().slice(0, 10);
}

function waitedDays(from: Date): number {
  return Math.max(0, Math.floor((Date.now() - from.getTime()) / 86_400_000));
}

export type { FocusPlan };
