// K6–K8: каскад целей, разбор задач и сигнал по KPI. Числа считает код, имена берутся из данных.

export interface GoalRef {
  n: string;
  text: string;
}

export interface PersonGoal {
  name: string;
  goal: string;
  leaderGoal: string;
  emails: number;
  kpis: {
    name: string;
    unit: string;
    better: string;
    weeks: { fact: string; status: string }[];
    quarter?: { plan: string; fact: string; status: string } | null;
  }[];
}

export interface TaskRow {
  title: string;
  owner: string;
  due: string;
  status: string;
}

export interface CascadeGoal {
  n: string;
  text: string;
  owners: string[];
  kpis: string[];
  tasks: string[];
}

export interface Hole {
  kind: 'цель без владельца' | 'человек без цели' | 'KPI без цели' | 'KPI нет' | 'задача без цели';
  text: string;
}

export interface TaskReview {
  title: string;
  owner: string;
  goal: string;
  effect: 'высокий' | 'средний' | 'низкий';
  deadline: 'да' | 'риск' | 'нет';
  overload: boolean;
  recommendation: 'оставить' | 'снять' | 'перенести' | 'передать';
  basis: string;
}

export interface KpiSignal {
  name: string;
  kpi: string;
  behind: number;
  trend: 'растёт' | 'падает' | 'ровно';
  forecast: string;
  unit: string;
  early: boolean;
  text: string;
}

export function profileGoals(profile: string): GoalRef[] {
  const chunk = profile.split(/^## /m).find((part) => part.startsWith('Цели'));
  if (!chunk) return [];
  const body = chunk.split(/^## /m)[0] ?? chunk;
  return [...body.matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map((match) => ({
    n: match[1] ?? '',
    text: (match[2] ?? '').replace(/\.+\s*$/, '').trim(),
  }));
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-zа-яё0-9]+/i).filter((word) => word.length >= 4);
}

function overlap(left: string, right: string): boolean {
  const bag = new Set(tokens(right));
  return tokens(left).some((word) => bag.has(word));
}

function goalsOf(person: PersonGoal, goals: GoalRef[]): GoalRef[] {
  return goals.filter((goal) => person.leaderGoal === goal.n || overlap(person.goal, goal.text));
}

function profileBundle(person: PersonGoal, goals: GoalRef[]): boolean {
  const bundle = goals.map((goal) => goal.text).join('. ');
  return person.leaderGoal === '' && bundle !== '' && person.goal === bundle;
}

export function goalKpiLine(kpi: PersonGoal['kpis'][number]): string | null {
  const quarter = kpi.quarter;
  if (!quarter) return null;
  const plan = quarter.plan.replace('.', ',');
  const fact = quarter.fact.replace('.', ',');
  const numbers = kpi.unit === '%' ? `${plan}% → ${fact}%` : `${plan} → ${fact}${kpi.unit ? ` ${kpi.unit}` : ''}`;
  const mark = quarter.status === 'отстаёт' ? 'отстаёт' : 'не отстаёт';
  return `${kpi.name}: ${numbers}, ${mark}`;
}

function assigneeGoal(person: PersonGoal | undefined, goals: GoalRef[], off: boolean): { text: string; profile: boolean } {
  if (!person || off || person.goal.trim() === '') return { text: '', profile: false };
  return { text: person.goal, profile: goalsOf(person, goals).length > 0 };
}

export function goalCascade(input: { goals: GoalRef[]; people: PersonGoal[]; tasks: TaskRow[]; offGoal?: string[] }): { goals: CascadeGoal[]; holes: Hole[] } {
  const off = new Set(input.offGoal ?? []);
  const goals = input.goals.map((goal) => {
    const owners = input.people.filter((person) => !profileBundle(person, input.goals) && (person.leaderGoal === goal.n || overlap(person.goal, goal.text)));
    const covered = new Set(owners.map((person) => person.name));
    return {
      n: goal.n,
      text: goal.text,
      owners: owners.map((person) => person.name),
      kpis: owners.flatMap((person) => person.kpis.map((kpi) => goalKpiLine(kpi)).filter((line): line is string => line !== null)),
      tasks: input.tasks
        .filter((task) => {
          if (!covered.has(task.owner)) return false;
          const person = input.people.find((row) => row.name === task.owner);
          return assigneeGoal(person, input.goals, off.has(task.title)).text !== '';
        })
        .map((task) => task.title),
    };
  });
  const holes: Hole[] = [];
  for (const goal of goals) {
    if (goal.owners.length === 0) holes.push({ kind: 'цель без владельца', text: goal.text });
    else if (goal.kpis.length === 0) holes.push({ kind: 'KPI нет', text: goal.text });
  }
  for (const person of input.people) {
    if (person.goal.trim() === '') holes.push({ kind: 'человек без цели', text: person.name });
    if (person.goal.trim() === '' && person.kpis.length > 0) holes.push({ kind: 'KPI без цели', text: person.name });
  }
  for (const task of input.tasks) {
    const person = input.people.find((row) => row.name === task.owner);
    if (!assigneeGoal(person, input.goals, off.has(task.title)).text) holes.push({ kind: 'задача без цели', text: task.title });
  }
  return { goals, holes };
}

export function reviewTasks(input: { goals: GoalRef[]; people: PersonGoal[]; tasks: TaskRow[]; offGoal?: string[] }): TaskReview[] {
  const off = new Set(input.offGoal ?? []);
  const open = input.tasks.filter((task) => task.status !== 'сделана' && task.status !== 'закрыта');
  const byOwner = new Map<string, number>();
  for (const task of open) byOwner.set(task.owner, (byOwner.get(task.owner) ?? 0) + 1);
  const loads = [...byOwner.values()].sort((a, b) => a - b);
  const median = loads.length ? loads[Math.floor((loads.length - 1) / 2)] ?? 0 : 0;
  return input.tasks.map((task) => {
    const person = input.people.find((row) => row.name === task.owner);
    const link = assigneeGoal(person, input.goals, off.has(task.title));
    const goal = link.text;
    const effect = link.profile ? 'высокий' : goal ? 'средний' : 'низкий';
    const deadline = task.status === 'просрочена' ? 'нет' : 'да';
    const count = byOwner.get(task.owner) ?? 0;
    const overload = count > median && median > 0;
    let recommendation: TaskReview['recommendation'] = 'оставить';
    if (!goal) recommendation = 'снять';
    else if (deadline === 'нет') recommendation = 'перенести';
    else if (overload && effect === 'низкий') recommendation = 'передать';
    const basis = [
      goal ? `Двигает цель исполнителя «${goal}».` : person ? 'У исполнителя нет цели.' : 'Исполнитель не найден в отделе.',
      `Эффект ${effect}.`,
      deadline === 'нет' ? 'Срок уже сорван.' : 'Срок в данных не сорван.',
      overload ? `У ${task.owner} открытых задач ${count}, это выше середины (${median}).` : `Нагрузка ${task.owner}: ${count}, не выше середины (${median}).`,
    ].join(' ');
    return { title: task.title, owner: task.owner, goal, effect, deadline, recommendation, overload, basis };
  });
}

export function kpiOutlook(weeks: { fact: string; status: string }[]): { behind: number; trend: 'растёт' | 'падает' | 'ровно'; forecast: string } {
  let behind = 0;
  for (let i = weeks.length - 1; i >= 0; i -= 1) {
    if (weeks[i]?.status !== 'отстаёт') break;
    behind += 1;
  }
  const nums = weeks.map((week) => Number(week.fact)).filter((value) => Number.isFinite(value));
  if (nums.length < 2) return { behind, trend: 'ровно', forecast: nums.at(-1)?.toString() ?? '' };
  const first = nums[0] ?? 0;
  const last = nums[nums.length - 1] ?? 0;
  const step = (last - first) / (nums.length - 1);
  const trend = step > 0.01 ? 'растёт' : step < -0.01 ? 'падает' : 'ровно';
  const forecast = Math.round((last + step) * 10) / 10;
  return { behind, trend, forecast: String(forecast) };
}

export function withLeader(profile: string, leaderName: string, people: PersonGoal[]): PersonGoal[] {
  if (people.some((person) => person.name === leaderName)) return people;
  return [...people, { name: leaderName, goal: profileGoals(profile).map((goal) => goal.text).join('. '), leaderGoal: '', emails: 0, kpis: [] }];
}

export function controlOf(profile: string, people: PersonGoal[], tasks: TaskRow[]) {
  const goals = profileGoals(profile);
  const cascade = goalCascade({ goals, people, tasks });
  return { goals: cascade.goals, holes: cascade.holes, tasks: reviewTasks({ goals, people, tasks }), signals: kpiSignals(people) };
}

export function kpiSignals(people: PersonGoal[]): KpiSignal[] {
  const signals: KpiSignal[] = [];
  for (const person of people) {
    for (const kpi of person.kpis) {
      const outlook = kpiOutlook(kpi.weeks);
      const early = person.emails === 0 && outlook.behind > 0;
      if (outlook.behind < 2 && !early) continue;
      const text = early
        ? `${person.name}: ${kpi.name} отстаёт ${outlook.behind} нед., писем нет. Прогноз ${outlook.forecast} ${kpi.unit}. Что мешает и что нужно от руководителя?`
        : `${person.name}: ${kpi.name} ниже плана ${outlook.behind} нед. подряд, факт ${outlook.trend}. Прогноз ${outlook.forecast} ${kpi.unit}.`;
      signals.push({ name: person.name, kpi: kpi.name, behind: outlook.behind, trend: outlook.trend, forecast: outlook.forecast, unit: kpi.unit, early, text });
    }
  }
  return signals;
}
