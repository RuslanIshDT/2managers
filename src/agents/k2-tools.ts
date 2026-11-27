// K2 с инструментами: модель сама решает, что узнать об отправителе, затем выносит вердикт по схеме.
// Данные инструментов — только данные этого руководителя, переданные в контексте. N1 и лимиты проверяет код после модели.
import { callTools, type ChatMessage, type ToolCall, type ToolSpec } from '../llm.ts';
import { kpiStatus } from './k1.ts';
import { judgeLetter, type ModelVerdict } from './k2.ts';

export interface K2Person {
  name: string;
  position: string;
  zone: string;
  goal: string;
  leaderGoal: string;
}

export interface K2Context {
  person: K2Person;
  authorities: { area: string; limitValue: string; unit: string; note: string }[];
  kpi: { name: string; unit: string; better: string; week: string; plan: string; fact: string }[];
  tasks: { title: string; dueOn: string; status: string }[];
  history: { area: string; subject: string; outcome: string; at: string }[];
  thread: { subject: string; received: string; verdict: string }[];
  revisions: { category: string; instead: string }[];
}

const OBJECT = { type: 'object', properties: {}, additionalProperties: false };

export const K2_TOOLS: ToolSpec[] = [
  { name: 'person_card', description: 'Карточка отправителя: должность, зона ответственности, его цель и цель руководителя, к которой она ведёт', parameters: OBJECT },
  { name: 'authorities', description: 'Полномочия отправителя: что он решает сам и до какого предела', parameters: OBJECT },
  { name: 'kpi', description: 'KPI отправителя по неделям: план, факт, отстаёт или нет', parameters: OBJECT },
  { name: 'open_tasks', description: 'Открытые задачи отправителя со сроками и статусом', parameters: OBJECT },
  {
    name: 'past_decisions',
    description: 'Как руководитель уже решал похожие просьбы этого человека. query — слово из темы, например «скидка»; пусто — все',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  { name: 'thread', description: 'Прежние письма этого человека руководителю: тема, дата, чем закончился разбор', parameters: OBJECT },
  { name: 'leader_edits', description: 'Как руководитель правил черновики ответов: учитывать в черновике', parameters: OBJECT },
];

export const MAX_STEPS = 5;

const SYSTEM_TOOLS = `Ты — агент полномочий руководителя. Пришло письмо подчинённого. Прежде чем решать, собери нужное инструментами: кто он, что ему разрешено, как идут его KPI и задачи, как руководитель решал похожее раньше. Вызывай только то, что нужно для этого письма; можно несколько инструментов за шаг. Когда данных хватает — ответь одной фразой «готово» без инструментов. Не выдумывай данных, которых не вернули инструменты.`;

const FINAL = `Данных достаточно. Вынеси вердикт по схеме. Опирайся только на письмо, профиль и то, что вернули инструменты; в основании назови полномочие, KPI, цель или прошлое решение, которые привели к вердикту.`;

export function runTool(name: string, args: Record<string, unknown>, ctx: K2Context): string {
  switch (name) {
    case 'person_card': {
      const p = ctx.person;
      return [`${p.name}, ${p.position || 'должность не указана'}`, `Зона: ${p.zone || 'не указана'}`, `Цель: ${p.goal || 'не указана'}`, p.leaderGoal ? `Ведёт к цели руководителя № ${p.leaderGoal}` : 'С целью руководителя не связан'].join('\n');
    }
    case 'authorities':
      return ctx.authorities.length
        ? ctx.authorities.map((row) => `${row.area}: до ${row.limitValue}${row.unit === '%' ? '%' : row.unit ? ` ${row.unit}` : ''}${row.note ? ` (${row.note})` : ''}`).join('\n')
        : 'Полномочий не записано: всё, что выходит за зону, решает руководитель';
    case 'kpi': {
      const weeks = ctx.kpi.filter((row) => row.week !== 'квартал').sort((a, b) => a.week.localeCompare(b.week));
      if (!weeks.length) return 'KPI не записаны';
      return weeks.map((row) => `${row.name}, ${row.week}: план ${row.plan}, факт ${row.fact} ${row.unit} — ${kpiStatus(row.better, row.plan, row.fact)}`).join('\n');
    }
    case 'open_tasks': {
      const open = ctx.tasks.filter((row) => !/готов|закрыт|сделан/i.test(row.status));
      return open.length ? open.map((row) => `${row.title}, срок ${row.dueOn}, ${row.status}`).join('\n') : 'Открытых задач нет';
    }
    case 'past_decisions': {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const rows = query ? ctx.history.filter((row) => `${row.area} ${row.subject}`.toLowerCase().includes(query)) : ctx.history;
      if (!rows.length) return query ? `Похожих решений по «${query}» нет` : 'Прошлых решений нет';
      return rows.slice(-12).map((row) => `${row.at}: ${row.subject} (${row.area}) — ${row.outcome}`).join('\n');
    }
    case 'thread':
      return ctx.thread.length ? ctx.thread.slice(-10).map((row) => `${row.received}: ${row.subject} — ${row.verdict || 'без разбора'}`).join('\n') : 'Прежних писем нет';
    case 'leader_edits':
      return ctx.revisions.length ? ctx.revisions.slice(-8).map((row) => `${row.category}: ${row.instead}`).join('\n') : 'Правок нет';
    default:
      return `Инструмента ${name} нет. Доступны: ${K2_TOOLS.map((tool) => tool.name).join(', ')}`;
  }
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.function.arguments || '{}');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface K2Run {
  verdict: ModelVerdict;
  steps: { tool: string; args: string }[];
  rounds: number;
}

export async function judgeWithTools(input: { purpose: string; profile: string; subject: string; body: string; ctx: K2Context }): Promise<K2Run> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_TOOLS },
    {
      role: 'user',
      content: ['Профиль руководителя:', input.profile.trim(), '', `Письмо от ${input.ctx.person.name}. Тема: ${input.subject}`, input.body.trim()].join('\n'),
    },
  ];
  const steps: K2Run['steps'] = [];
  let rounds = 0;
  while (rounds < MAX_STEPS) {
    const reply = await callTools(`${input.purpose}:step${rounds + 1}`, messages, K2_TOOLS);
    rounds += 1;
    if (!reply.toolCalls.length) break;
    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const args = parseArgs(call);
      steps.push({ tool: call.function.name, args: call.function.arguments || '{}' });
      messages.push({ role: 'tool', tool_call_id: call.id, content: runTool(call.function.name, args, input.ctx) });
    }
  }
  messages.push({ role: 'user', content: FINAL });
  const verdict = await judgeLetter({ purpose: input.purpose, prompt: '', messages, tools: K2_TOOLS });
  return { verdict, steps, rounds };
}

const TOOL_WORDS: Record<string, string> = {
  person_card: 'карточку',
  authorities: 'полномочия',
  kpi: 'KPI',
  open_tasks: 'задачи',
  past_decisions: 'прошлые решения',
  thread: 'прежние письма',
  leader_edits: 'ваши правки',
};

export function stepsWords(steps: K2Run['steps']): string {
  if (!steps.length) return 'Помощник решил по письму и профилю, данные не запрашивал';
  const names = steps.map((step) => {
    const word = TOOL_WORDS[step.tool] ?? step.tool;
    if (step.tool !== 'past_decisions') return word;
    let query = '';
    try {
      query = String((JSON.parse(step.args) as { query?: unknown }).query ?? '').trim();
    } catch {
      query = '';
    }
    return query ? `${word} («${query}»)` : word;
  });
  return `Помощник посмотрел: ${[...new Set(names)].join(', ')}`;
}
