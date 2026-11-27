// Утро руководителя и матрица отдела. Модель не вызывается, имена берутся из данных.
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
  if (!rows.length) return ['Просроченных задач исполнителей нет.'];
  return ['Просроченные задачи:', ...rows.map((row) => `— ${row.owner}: ${row.title}, просрочена на ${row.days} дн.`)];
}

export function morningLines(input: {
  tasks: { title: string; dueOn: string }[];
  waiting: { who: string; summary: string }[];
  quiet: string[];
  overdue?: { title: string; owner: string; days: number }[];
}): string[] {
  const lines = ['Утро. Что действительно ваше:'];
  if (input.tasks.length) {
    for (const task of input.tasks) lines.push(`— ${task.title}, срок ${dateWords(task.dueOn)}`);
  } else {
    lines.push('— своих задач со сроком нет');
  }
  if (input.waiting.length) {
    lines.push('Ждут вашего решения:');
    for (const row of input.waiting) lines.push(`— ${row.who}: ${row.summary}`);
  } else {
    lines.push('Открытых решений, которые ждут вас, нет.');
  }
  if (input.quiet.length) lines.push(`Тихая проблема: ${input.quiet.join(', ')}.`);
  if (input.overdue) lines.push(...overdueLines(input.overdue));
  return lines;
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
