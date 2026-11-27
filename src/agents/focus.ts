// Утро руководителя и матрица отдела. Модель здесь не вызывается, имена берутся из данных.
import { applyMorning, morningLimit, type MorningBlockId, type MorningShape } from './morning.ts';
import { dateWords } from './scene.ts';
export type MatrixCell = 'один_на_один' | 'помочь' | 'расширить' | 'не_трогать';

export interface MatrixInput {
  name: string;
  emails: number;
  lagging: boolean;
}

export interface MatrixRow {
  name: string;
  cell: MatrixCell;
  emails: number;
  lagging: boolean;
  quiet: boolean;
  basis: string;
}

export function departmentMatrix(people: MatrixInput[]): MatrixRow[] {
  const counts = people.map((person) => person.emails).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor((counts.length - 1) / 2)] : 0;
  return people.map((person) => {
    const many = person.emails > median;
    const cell: MatrixCell = person.lagging
      ? many
        ? 'помочь'
        : 'один_на_один'
      : many
        ? 'расширить'
        : 'не_трогать';
    const quiet = person.lagging && person.emails === 0;
    const load = many ? `писем ${person.emails}, это выше середины отдела (${median})` : `писем ${person.emails}, не выше середины отдела (${median})`;
    const kpi = person.lagging ? 'KPI отстаёт' : 'KPI в норме';
    const advice =
      cell === 'один_на_один'
        ? 'Встреча один на один'
        : cell === 'помочь'
          ? 'Помочь по существу'
          : cell === 'расширить'
            ? 'Расширить полномочия'
            : 'Не трогать';
    return {
      name: person.name,
      cell,
      emails: person.emails,
      lagging: person.lagging,
      quiet,
      basis: `${advice}. ${kpi}, ${load}.${quiet ? ' Тихая проблема: отстаёт и не пишет.' : ''}`,
    };
  });
}

const CLOSED_TASK = new Set(['сделана', 'закрыта', 'отменена']);

export function isLeaderTask(owner: string, leaderName: string): boolean {
  return owner === leaderName || owner === 'не назван';
}

// Название без повтора имени: утро само ставит имя перед задачей.
export function taskTitle(title: string, owner: string): string {
  let text = title.trim();
  const prefix = owner.trim();
  if (!prefix) return text;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\-—]?\\s*`, 'i');
  while (re.test(text)) text = text.replace(re, '').trim();
  return text || title.trim();
}

export function lateWords(days: number): string {
  return `просрочено на ${dayCount(days)}`;
}

export function overdueTasks(
  tasks: { title: string; owner: string; dueOn: string; status: string }[],
  today: string,
): { title: string; owner: string; dueOn: string; days: number }[] {
  return tasks
    .filter((task) => !CLOSED_TASK.has(task.status))
    .flatMap((task) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(task.dueOn) || task.dueOn >= today) return [];
      const [year, month, day] = task.dueOn.split('-').map(Number);
      const [nowYear, nowMonth, nowDay] = today.split('-').map(Number);
      const days = Math.round((Date.UTC(nowYear, nowMonth - 1, nowDay) - Date.UTC(year, month - 1, day)) / 86_400_000);
      return [{ title: task.title, owner: task.owner, dueOn: task.dueOn, days }];
    })
    .sort((a, b) => b.days - a.days || a.owner.localeCompare(b.owner, 'ru') || a.title.localeCompare(b.title, 'ru'));
}

export function overdueLines(rows: { title: string; owner: string; days: number }[]): string[] {
  if (!rows.length) return ['Просроченных задач у сотрудников нет.'];
  const sorted = [...rows].sort((a, b) => b.days - a.days || a.owner.localeCompare(b.owner, 'ru') || a.title.localeCompare(b.title, 'ru'));
  const shown = sorted.slice(0, 10);
  const lines = ['Просрочено у сотрудников:', ...shown.map((row) => `— ${row.owner}: ${taskTitle(row.title, row.owner)} — ${lateWords(row.days)}`)];
  if (sorted.length > shown.length) lines.push(`ещё ${sorted.length - shown.length}`);
  return lines;
}

// Совет матрицы глаголом: так строка становится делом руководителя. «Не трогать» делом не бывает.
export function adviceTitle(row: { name: string; cell: MatrixCell }): string | null {
  if (row.cell === 'один_на_один') return `${row.name} — поговорить один на один`;
  if (row.cell === 'помочь') return `${row.name} — помочь по существу`;
  if (row.cell === 'расширить') return `${row.name} — расширить полномочия`;
  return null;
}

export interface MorningInput {
  today: string;
  waiting: { who: string; what: string; days: number }[];
  ownWeek: { title: string; dueOn: string }[];
  plan: { title: string; goal: string; minutes: number; why: string }[] | null;
  returned: { who: string; what: string }[];
  overdue: { title: string; owner: string; days: number }[];
  todayMeetings: string[];
  oneOnOne?: { name: string; lines: { text: string; sources: { label: string; href: string }[] }[] }[];
  questions: { title: string; items: string[] }[];
  share: { onGoal: number; total: number; percent: number };
  notes?: string[];
  morning?: MorningShape | null;
}

// Утреннее сообщение (порядок — владелец 27.11.2026, T66). Сначала то, что взято из систем: решения из почты,
// ваши задачи из Трекера, встречи из календаря. Затем то, что собрали агенты: три дела, просрочки сотрудников,
// открытые вопросы протокола, время на цели, ответы помощника.
export function renderMorning(input: MorningInput): string {
  const parts = new Map<MorningBlockId, string>();
  parts.set(
    'waiting',
    (input.waiting.length
      ? ['Ждут вашего решения:', ...input.waiting.map((row) => `— ${row.who}: ${row.what} (${waitWords(row.days)})`)]
      : ['Решений, которые ждут вас, нет.']
    ).join('\n'),
  );
  parts.set(
    'own',
    (input.ownWeek.length
      ? ['Ваши задачи со сроком в ближайшую неделю:', ...input.ownWeek.map((task) => `— ${task.title}, ${dueWords(task.dueOn, input.today)}`)]
      : ['Ваших задач со сроком в ближайшую неделю нет.']
    ).join('\n'),
  );
  parts.set('meetings', meetingsBlock(input));
  parts.set(
    'plan',
    input.plan === null
      ? 'Три дела на сегодня модель выберет при отправке.'
      : input.plan.length
        ? ['Три дела на сегодня:', ...input.plan.map((item, index) => `${index + 1}. ${item.title}. ${item.minutes} мин, цель «${item.goal}». ${item.why}`)].join('\n')
        : 'Три дела на сегодня: модель не выбрала ни одного.',
  );
  parts.set('overdue', overdueLines(input.overdue).join('\n'));
  if (input.questions.length)
    parts.set('questions', ['Вопросы по прошлым протоколам:', ...input.questions.flatMap((group) => [`${group.title}:`, ...group.items.map((item) => `— ${item}`)])].join('\n'));
  parts.set('share', `Время встреч на ваши цели: ${input.share.percent}% (${hours(input.share.onGoal)} из ${hours(input.share.total)} ч по календарю).`);
  parts.set(
    'returned',
    input.returned.length
      ? ['Помощник ответил сам на этой неделе:', ...input.returned.map((row) => `— ${row.who}: ${row.what}`)].join('\n')
      : 'На этой неделе помощник сам ни на одно письмо не отвечал.',
  );
  const blocks = [`План на ${dateWords(input.today)}`];
  for (const id of applyMorning(input.morning)) {
    const text = capLines(parts.get(id), morningLimit(input.morning, id));
    if (text) blocks.push(text);
  }
  if (input.notes?.length) blocks.push(input.notes.join('\n'));
  return blocks.join('\n\n');
}

function capLines(text: string | undefined, max: number | null): string | undefined {
  if (!text || !max || max < 1) return text;
  const lines = text.split('\n');
  return [lines[0], ...lines.slice(1, 1 + max)].filter((line) => line !== undefined).join('\n');
}

function meetingsBlock(input: MorningInput): string {
  const line = input.todayMeetings.length ? `Встречи сегодня: ${input.todayMeetings.join('; ')}.` : 'Сегодня встреч в календаре нет.';
  const briefs = (input.oneOnOne ?? []).filter((block) => block.lines.length);
  if (!briefs.length) return line;
  const blocks = briefs.map((block) => {
    const lines = block.lines.flatMap((item) => [
      `— ${item.text}`,
      ...item.sources.map((source) => (source.href ? `  ${source.label} ${source.href}` : `  ${source.label}`)),
    ]);
    return [`Что ${block.name} ждёт от вас:`, ...lines].join('\n');
  });
  return [line, ...blocks].join('\n\n');
}

// Свои задачи руководителя, которые показываются всегда: срок в ближайшие 7 дней или уже прошёл (владелец 27.11.2026).
export const OWN_WEEK_DAYS = 7;

export function ownWeekTasks<T extends { dueOn: string; status: string }>(tasks: T[], today: string): T[] {
  const until = addDays(today, OWN_WEEK_DAYS);
  return tasks
    .filter((task) => !CLOSED_TASK.has(task.status))
    .filter((task) => /^\d{4}-\d{2}-\d{2}$/.test(task.dueOn) && task.dueOn <= until)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

function dueWords(dueOn: string, today: string): string {
  const days = Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return `срок был ${dateWords(dueOn)}, просрочено на ${dayCount(-days)}`;
  if (days === 0) return `срок сегодня, ${dateWords(dueOn)}`;
  if (days === 1) return `срок завтра, ${dateWords(dueOn)}`;
  return `срок ${dateWords(dueOn)}, через ${dayCount(days)}`;
}

function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

function waitWords(days: number): string {
  if (days < 1) return 'ждёт меньше дня';
  return `ждёт ${dayCount(days)}`;
}

function dayCount(n: number): string {
  const tail = n % 10;
  const hundred = n % 100;
  const word = tail === 1 && hundred !== 11 ? 'день' : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? 'дня' : 'дней';
  return `${n} ${word}`;
}

function hours(minutes: number): string {
  return (Math.round((minutes / 60) * 10) / 10).toLocaleString('ru-RU');
}

// Время на цели: встречи, вид которых входит в goalKinds, и блоки освобождённого времени под приоритет (T57).
// Вид серии определяет помощник; серия без вида на цели не считается.
export function goalMinutes(
  meetings: { minutes: number; kind?: string; goal?: boolean }[],
  goalKinds: Set<string>,
): { onGoal: number; total: number; percent: number } {
  let onGoal = 0;
  let total = 0;
  for (const meeting of meetings) {
    total += meeting.minutes;
    if (meeting.goal || (meeting.kind && goalKinds.has(meeting.kind))) onGoal += meeting.minutes;
  }
  return { onGoal, total, percent: total === 0 ? 0 : Math.round((100 * onGoal) / total) };
}

export function morningHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/^([ \t]*)(\S[^\n]*?)[ \t]+(https:\/\/\S+)$/gm, (_, indent: string, label: string, url: string) => `${indent}<a href="${url}">${label}</a>`);
}
