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
  plan: { title: string; goal: string; minutes: number; why: string }[] | null;
  returned: { who: string; what: string }[];
  overdue: { title: string; owner: string; days: number }[];
  todayMeetings: string[];
  openItems: string[];
  share: { onGoal: number; total: number; percent: number };
}

// Утреннее сообщение целиком: сначала решения, которые ждут руководителя, затем три дела и что сделано без него.
export function renderMorning(input: MorningInput): string {
  const blocks: string[][] = [[`План на ${dateWords(input.today)}`]];
  blocks.push(
    input.waiting.length
      ? ['Ждут вашего решения:', ...input.waiting.map((row) => `— ${row.who}: ${row.what} (${waitWords(row.days)})`)]
      : ['Решений, которые ждут вас, нет.'],
  );
  if (input.plan === null) blocks.push(['Три дела на сегодня модель выберет при отправке.']);
  else if (!input.plan.length) blocks.push(['Три дела на сегодня: модель не выбрала ни одного.']);
  else
    blocks.push([
      'Три дела на сегодня:',
      ...input.plan.map((item, index) => `${index + 1}. ${item.title}. ${item.minutes} мин, цель «${item.goal}». ${item.why}`),
    ]);
  blocks.push(
    input.returned.length
      ? ['Помощник сам вернул людям на этой неделе, они решают это сами:', ...input.returned.map((row) => `— ${row.who}: ${row.what}`)]
      : ['На этой неделе помощник никому письма не возвращал.'],
  );
  blocks.push(overdueLines(input.overdue));
  blocks.push([input.todayMeetings.length ? `Встречи сегодня: ${input.todayMeetings.join('; ')}.` : 'Сегодня встреч в календаре нет.']);
  if (input.openItems.length) blocks.push(['Открытые вопросы прошлой встречи:', ...input.openItems.map((item) => `— ${item}`)]);
  blocks.push([
    `Время встреч на ваши цели: ${input.share.percent}% (${hours(input.share.onGoal)} из ${hours(input.share.total)} ч по календарю).`,
  ]);
  return blocks.map((block) => block.join('\n')).join('\n\n');
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

export function goalMinutes(
  meetings: { minutes: number; summary: string; goal?: boolean }[],
  goals: string[],
): { onGoal: number; total: number; percent: number } {
  const needles = goals
    .flatMap((goal) => goal.toLowerCase().split(/[^a-zа-яё0-9]+/i))
    .filter((word) => word.length >= 5);
  let onGoal = 0;
  let total = 0;
  for (const meeting of meetings) {
    total += meeting.minutes;
    const summary = meeting.summary.toLowerCase();
    // goal: блок освобождённого времени, отданный приоритету руководителя (T57).
    if (meeting.goal || needles.some((word) => summary.includes(word))) onGoal += meeting.minutes;
  }
  return { onGoal, total, percent: total === 0 ? 0 : Math.round((100 * onGoal) / total) };
}
