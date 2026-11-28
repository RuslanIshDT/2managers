// Подключение руководителя формой. Пункты профиля читаются из шаблона, не из кода.
import { randomBytes } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { agentRuns, authorities, emailEtalon, emails, kpis, leaders, meetingEtalon, meetings, people, tasks } from '../db/schema.ts';
import { hashPassword } from '../auth.ts';
import { loadSynthetic, type Synthetic } from '../data/synthetic.ts';
import { readHistory } from './dependence.ts';
import { checkDepartment, loadDepartment, readDepartment } from './k1.ts';
import { moscowDay, parseSceneFile } from './scene.ts';
import { confirmationPoints } from './confirm.ts';
import { profileItems } from './free-time.ts';
import { goalsMarkdown, parseGoals, type GoalFileRow } from './profile-file.ts';
import { controlOf, withLeader, type PersonGoal } from './control.ts';
import { insertCatalog } from '../db/seed.ts';
import { classifyNewSeries } from './focus-run.ts';
import { refreshAudiences } from './audience.ts';

export const SOURCE_NOTE =
  'На стенде этот каталог заменяет кадровую систему, систему целей, отчётность KPI, регламент полномочий и почту, календарь и задачи руководителя.';

export const STUB_NOTE =
  'не подключено: на стенде живые почта, календарь и Трекер у Ивана; письма, встречи и задачи — из источника';

const NEEDED = ['org_structure.csv', 'inbox.csv', 'calendar.ics', 'tasks.csv', 'department.csv', 'kpi.csv', 'authority.csv', 'goals.csv', 'decisions_history.csv'];

export interface TemplateLists {
  confirm: string[];
  time: string[];
  rest: string;
}

export interface StoredLinks {
  mailAddress: string;
  trackerOrg: string;
  trackerQueue: string;
}

export interface ConnectRequest {
  source: string;
  personId: string;
  login: string;
  password: string;
  confirm: string[];
  confirmOwn: string;
  time: string[];
  timeOwn: string;
  hours: string;
  mailAddress: string;
  mailPassword?: string;
  calendarPassword?: string;
  trackerOrg: string;
  trackerQueue: string;
  trackerToken?: string;
}

export interface ConnectSummary {
  login: string;
  people: number;
  emails: number;
  meetings: number;
  tasks: number;
  goals: number;
  holes: { kind: string; text: string }[];
}

export function templateLists(markdown: string): TemplateLists {
  const blocks = markdown.split(/^## /m).slice(1);
  const confirm: string[] = [];
  const time: string[] = [];
  const rest: string[] = [];
  for (const block of blocks) {
    const title = block.split('\n')[0] ?? '';
    const full = `## ${block.trimEnd()}`;
    if (/^Никогда без подтверждения/i.test(title)) confirm.push(...profileItems(full, /^Никогда без подтверждения/i));
    else if (/освобожд/i.test(title)) time.push(...profileItems(full, /освобожд/i));
    else if (/^Цели/i.test(title)) continue;
    else rest.push(full);
  }
  return { confirm, time, rest: rest.join('\n\n') };
}

export function ownLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function storedLinks(input: {
  mailAddress?: string;
  mailPassword?: string;
  calendarPassword?: string;
  trackerOrg?: string;
  trackerQueue?: string;
  trackerToken?: string;
}): StoredLinks {
  return {
    mailAddress: (input.mailAddress ?? '').trim(),
    trackerOrg: (input.trackerOrg ?? '').trim(),
    trackerQueue: (input.trackerQueue ?? '').trim(),
  };
}

export function acceptLogin(login: string, taken: string[]): string | null {
  const value = login.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(value)) return 'Логин: буквы и цифры, от 1 до 32 знаков';
  if (taken.some((row) => row.toLowerCase() === value.toLowerCase())) return 'Такой логин уже есть';
  return null;
}

export function acceptPassword(password: string): string | null {
  if (password.length < 8) return 'Пароль короче 8 символов';
  if (password.length > 200) return 'Пароль слишком длинный';
  return null;
}

export function acceptSource(id: string, taken: string[]): string | null {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(id)) return 'Некорректный источник';
  if (taken.includes(id)) return 'Этот источник уже подключён';
  return null;
}

export function acceptHours(hours: string): string | null {
  const value = hours.trim();
  if (!value) return null;
  if (!/^\d{1,3}([.,]\d)?$/.test(value)) return 'Часы в неделю — число или пусто';
  return null;
}

export function buildProfile(input: {
  name: string;
  position: string;
  goals: GoalFileRow[];
  confirm: string[];
  time: string[];
  hours: string;
  rest: string;
}): string {
  const lines = [
    `${input.name} — ${input.position}`,
    '',
    goalsMarkdown(input.goals),
    '',
    '## Никогда без подтверждения руководителя',
    ...input.confirm.map((item) => `- ${item}`),
    '',
    '## Куда направить освобождённое время',
    ...input.time.map((item) => `- ${item}`),
  ];
  if (input.hours.trim()) lines.push('', `Часов в неделю: ${input.hours.trim().replace(',', '.')}.`);
  const body = lines.join('\n');
  return input.rest.trim() ? `${body}\n\n${input.rest.trim()}\n` : `${body}\n`;
}

async function sourceTitle(dir: string, fallback: string): Promise<string> {
  try {
    const line = (await readFile(join(dir, 'source.txt'), 'utf8')).split(/\r?\n/).find((row) => row.trim());
    if (line?.trim()) return line.trim();
  } catch {
    // названия нет — берётся должность руководителя
  }
  return fallback;
}

export async function openSources(root: string, taken: string[]): Promise<{ id: string; title: string }[]> {
  const names = await readdir(root, { withFileTypes: true });
  const found: { id: string; title: string }[] = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (acceptSource(entry.name, taken)) continue;
    const dir = join(root, entry.name);
    try {
      await access(join(dir, 'org_structure.csv'));
    } catch {
      continue;
    }
    const data = await loadSynthetic(dir, { profileOptional: true }).catch(() => null);
    const leader = data?.people.find((person) => person.role === 'руководитель');
    found.push({ id: entry.name, title: await sourceTitle(dir, leader?.position || entry.name) });
  }
  return found;
}

export async function leadersInSource(dir: string): Promise<{ id: string; name: string; position: string; email: string }[]> {
  const data = await loadSynthetic(dir, { profileOptional: true });
  return data.people
    .filter((person) => person.role === 'руководитель')
    .map((person) => ({ id: person.id, name: person.name, position: person.position, email: person.email }));
}

export interface ReadyConnect {
  ok: true;
  profile: string;
  data: Synthetic;
  goals: GoalFileRow[];
  stored: StoredLinks;
  summary: ConnectSummary;
}

export async function previewConnect(
  dir: string,
  input: ConnectRequest,
  existing: { ids: string[]; logins: string[] },
  template: string,
): Promise<{ ok: false; errors: string[] } | ReadyConnect> {
  const errors: string[] = [];
  const sourceError = acceptSource(input.source, existing.ids);
  if (sourceError) errors.push(sourceError);
  const loginError = acceptLogin(input.login, existing.logins);
  if (loginError) errors.push(loginError);
  const passwordError = acceptPassword(input.password);
  if (passwordError) errors.push(passwordError);
  const hoursError = acceptHours(input.hours);
  if (hoursError) errors.push(hoursError);
  for (const name of NEEDED) {
    try {
      await access(join(dir, name));
    } catch {
      errors.push(`Нет файла ${name}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  let data: Synthetic;
  try {
    data = await loadSynthetic(dir, { profileOptional: true });
  } catch (err) {
    return { ok: false, errors: [`Источник не читается: ${err instanceof Error ? err.message : 'сбой'}`] };
  }
  const leader = data.people.find((person) => person.id === input.personId && person.role === 'руководитель');
  if (!leader) errors.push('В источнике нет такого руководителя');

  let goals: GoalFileRow[] = [];
  try {
    goals = parseGoals(await readFile(join(dir, 'goals.csv'), 'utf8'));
    if (goals.length === 0) errors.push('В файле целей нет ни одной цели');
  } catch {
    errors.push('Файл целей не читается');
  }

  let scene = '';
  try {
    scene = parseSceneFile(await readFile(join(dir, 'scene.csv'), 'utf8')) ?? '';
  } catch {
    scene = '';
  }
  try {
    await readHistory(dir);
  } catch {
    errors.push('История решений не читается');
  }
  try {
    const files = await readDepartment(dir);
    const checked = checkDepartment(data.people, files, scene || moscowDay(new Date()));
    errors.push(...checked.errors);
    if (errors.length || !leader) return { ok: false, errors };
    const lists = templateLists(template);
    const confirm = [...input.confirm.map((item) => item.trim()).filter(Boolean), ...ownLines(input.confirmOwn)];
    const time = [...input.time.map((item) => item.trim()).filter(Boolean), ...ownLines(input.timeOwn)];
    const profile = buildProfile({
      name: leader.name,
      position: leader.position,
      goals,
      confirm,
      time,
      hours: input.hours,
      rest: lists.rest,
    });
    const mail = new Map<string, number>();
    for (const letter of data.emails) {
      const person = data.people.find((row) => row.email.toLowerCase() === letter.fromEmail.toLowerCase());
      if (person) mail.set(person.id, (mail.get(person.id) ?? 0) + 1);
    }
    const departmentPeople: PersonGoal[] = checked.cards.map((card) => ({
      name: card.name,
      goal: card.goal,
      leaderGoal: card.leaderGoal,
      emails: mail.get(card.personId) ?? 0,
      kpis: card.kpis.map((kpi) => ({
        name: kpi.name,
        unit: kpi.unit,
        better: kpi.better,
        weeks: kpi.weeks.map((week) => ({ fact: week.fact, status: week.status })),
        quarter: kpi.quarter,
      })),
    }));
    const taskRows = data.tasks.map((task) => ({ title: task.task, owner: task.owner, due: task.due, status: task.status }));
    const cascade = controlOf(profile, withLeader(profile, leader.name, departmentPeople), taskRows);
    return {
      ok: true,
      profile,
      data,
      goals,
      stored: storedLinks(input),
      summary: {
        login: input.login.trim(),
        people: data.people.length,
        emails: data.emails.length,
        meetings: data.meetings.length,
        tasks: data.tasks.length,
        goals: goals.length,
        holes: cascade.holes,
      },
    };
  } catch (err) {
    return { ok: false, errors: [`Отдел не читается: ${err instanceof Error ? err.message : 'сбой'}`] };
  }
}

export async function connectLeader(db: Db, input: ConnectRequest, root = 'data'): Promise<{ ok: false; errors: string[] } | { ok: true; summary: ConnectSummary }> {
  const sourceError = acceptSource(input.source, []);
  if (sourceError && sourceError !== 'Этот источник уже подключён') return { ok: false, errors: [sourceError] };
  const rows = await db.select({ id: leaders.id, login: leaders.login }).from(leaders);
  const template = await readFile(join(root, 'profile-template.md'), 'utf8');
  const ready = await previewConnect(join(root, input.source), input, { ids: rows.map((row) => row.id), logins: rows.map((row) => row.login) }, template);
  if (!ready.ok) return ready;
  const passwordHash = await hashPassword(input.password);
  const linkCode = randomBytes(4).toString('hex');
  try {
    await db.insert(leaders).values({
      id: input.source,
      name: ready.data.people.find((person) => person.id === input.personId)?.name ?? '',
      login: ready.summary.login,
      passwordHash,
      profile: ready.profile,
      linkCode,
      telegramChatId: null,
      profileLocked: true,
      mailAddress: ready.stored.mailAddress,
      trackerOrg: ready.stored.trackerOrg,
      trackerQueue: ready.stored.trackerQueue,
    });
    await insertCatalog(db, input.source, ready.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/unique|duplicate/i.test(message)) return { ok: false, errors: ['Такой логин или источник уже есть'] };
    throw err;
  }
  const department = await loadDepartment(db, input.source, join(root, input.source));
  if (department.errors.length) {
    await removeFreshLeader(db, input.source);
    return { ok: false, errors: department.errors };
  }
  void finishNewLeader(db, input.source, ready.profile);
  return { ok: true, summary: ready.summary };
}

export async function finishNewLeader(db: Db, leaderId: string, profile: string): Promise<void> {
  try {
    await refreshAudiences(db, leaderId);
  } catch (err) {
    console.error('Пункты профиля не разобраны', leaderId, err instanceof Error ? err.message : err);
  }
  try {
    await classifyNewSeries(db, leaderId, profile);
  } catch (err) {
    console.error('Вид встреч не определён', leaderId, err instanceof Error ? err.message : err);
  }
}

async function removeFreshLeader(db: Db, leaderId: string) {
  await db.delete(kpis).where(eq(kpis.leaderId, leaderId));
  await db.delete(authorities).where(eq(authorities.leaderId, leaderId));
  await db.delete(agentRuns).where(eq(agentRuns.leaderId, leaderId));
  await db.delete(emailEtalon).where(eq(emailEtalon.leaderId, leaderId));
  await db.delete(emails).where(eq(emails.leaderId, leaderId));
  await db.delete(meetingEtalon).where(eq(meetingEtalon.leaderId, leaderId));
  await db.delete(meetings).where(eq(meetings.leaderId, leaderId));
  await db.delete(tasks).where(eq(tasks.leaderId, leaderId));
  await db.delete(people).where(eq(people.leaderId, leaderId));
  await db.delete(leaders).where(eq(leaders.id, leaderId));
}

export async function leaderDirectory(db: Db): Promise<{ name: string; login: string; people: number }[]> {
  const rows = await db.select({ id: leaders.id, name: leaders.name, login: leaders.login }).from(leaders);
  const result = [];
  for (const row of rows) {
    const n = await db.select({ n: count() }).from(people).where(eq(people.leaderId, row.id));
    result.push({ name: row.name, login: row.login, people: Number(n[0]?.n ?? 0) });
  }
  return result;
}

export function profileHasChoices(profile: string, confirm: string[], time: string[]): boolean {
  const gotConfirm = confirmationPoints(profile);
  const gotTime = profileItems(profile, /освобожд/i);
  return confirm.every((item) => gotConfirm.includes(item)) && time.every((item) => gotTime.includes(item));
}
