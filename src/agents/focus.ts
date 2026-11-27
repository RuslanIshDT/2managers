// Утро руководителя и матрица отдела. Модель здесь не вызывается, имена берутся из данных.
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

export function overdueTasks(
  tasks: { title: string; owner: string; dueOn: string; status: string }[],
  today: string,
): { title: string; owner: string; dueOn: string; days: number }[] {
  return tasks
    .filter((task) => task.status !== 'сделана' && task.status !== 'закрыта')
    .flatMap((task) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(task.dueOn) || task.dueOn >= today) return [];
      const [year, month, day] = task.dueOn.split('-').map(Number);
      const [nowYear, nowMonth, nowDay] = today.split('-').map(Number);
      const days = Math.round((Date.UTC(nowYear, nowMonth - 1, nowDay) - Date.UTC(year, month - 1, day)) / 86_400_000);
      return [{ title: task.title, owner: task.owner, dueOn: task.dueOn, days }];
    })
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title));
}

export function overdueLines(rows: { title: string; owner: string; days: number }[]): string[] {
  if (!rows.length) return ['Просроченных задач у сотрудников нет.'];
  return ['Просрочено у сотрудников:', ...rows.map((row) => `— ${row.owner}: ${row.title}, просрочено на ${dayCount(row.days)}`)];
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
  openItems: string[];
  share: { onGoal: number; total: number; percent: number };
  notes?: string[];
}

// Утреннее сообщение (порядок — владелец 27.11.2026, T66). Сначала то, что взято из систем: решения из почты,
// ваши задачи из Трекера, встречи из календаря. Затем то, что собрали агенты: три дела, просрочки сотрудников,
// открытые вопросы протокола, время на цели, ответы помощника.
export function renderMorning(input: MorningInput): string {
  const blocks: string[][] = [[`План на ${dateWords(input.today)}`]];
  blocks.push(
    input.waiting.length
      ? ['Ждут вашего решения:', ...input.waiting.map((row) => `— ${row.who}: ${row.what} (${waitWords(row.days)})`)]
      : ['Решений, которые ждут вас, нет.'],
  );
  blocks.push(
    input.ownWeek.length
      ? ['Ваши задачи со сроком в ближайшую неделю:', ...input.ownWeek.map((task) => `— ${task.title}, ${dueWords(task.dueOn, input.today)}`)]
      : ['Ваших задач со сроком в ближайшую неделю нет.'],
  );
  blocks.push([input.todayMeetings.length ? `Встречи сегодня: ${input.todayMeetings.join('; ')}.` : 'Сегодня встреч в календаре нет.']);
  if (input.plan === null) blocks.push(['Три дела на сегодня модель выберет при отправке.']);
  else if (!input.plan.length) blocks.push(['Три дела на сегодня: модель не выбрала ни одного.']);
  else
    blocks.push([
      'Три дела на сегодня:',
      ...input.plan.map((item, index) => `${index + 1}. ${item.title}. ${item.minutes} мин, цель «${item.goal}». ${item.why}`),
    ]);
  blocks.push(overdueLines(input.overdue));
  if (input.openItems.length) blocks.push(['Открытые вопросы прошлой встречи:', ...input.openItems.map((item) => `— ${item}`)]);
  blocks.push([
    `Время встреч на ваши цели: ${input.share.percent}% (${hours(input.share.onGoal)} из ${hours(input.share.total)} ч по календарю).`,
  ]);
  blocks.push(
    input.returned.length
      ? ['Помощник ответил сам на этой неделе — сотрудники решают это без вас:', ...input.returned.map((row) => `— ${row.who}: ${row.what}`)]
      : ['На этой неделе помощник сам ни на одно письмо не отвечал.'],
  );
  // Трекер или календарь не ответили — сказать, откуда взяты задачи и встречи.
  if (input.notes?.length) blocks.push(input.notes);
  return blocks.map((block) => block.join('\n')).join('\n\n');
}

// Свои задачи руководителя, которые показываются всегда: срок в ближайшие 7 дней или уже прошёл (владелец 27.11.2026).
export const OWN_WEEK_DAYS = 7;

export function ownWeekTasks<T extends { dueOn: string; status: string }>(tasks: T[], today: string): T[] {
  const until = addDays(today, OWN_WEEK_DAYS);
  return tasks
    .filter((task) => task.status !== 'сделана' && task.status !== 'закрыта')
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
