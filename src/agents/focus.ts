// Утро руководителя и матрица отдела. Модель не вызывается, имена берутся из данных.
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

export function morningLines(input: {
  tasks: { title: string; dueOn: string }[];
  waiting: { who: string; summary: string }[];
  quiet: string[];
}): string[] {
  const lines = ['Утро. Что действительно ваше:'];
  if (input.tasks.length) {
    for (const task of input.tasks) lines.push(`— ${task.title}, срок ${task.dueOn}`);
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
  return lines;
}

export function goalMinutes(
  meetings: { minutes: number; summary: string }[],
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
    if (needles.some((word) => summary.includes(word))) onGoal += meeting.minutes;
  }
  return { onGoal, total, percent: total === 0 ? 0 : Math.round((100 * onGoal) / total) };
}
