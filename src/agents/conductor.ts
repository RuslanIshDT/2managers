// Дирижёр: код собирает кандидатов, модель оставляет не больше трёх дел. Имена и цели приходят в данных.
import { z } from 'zod';
import { callJson, type JsonSchema } from '../llm.ts';

export interface Candidate {
  id: string;
  kind: string;
  title: string;
  detail: string;
  goal: string;
}

export interface Choice {
  id: string;
  goal: string;
  minutes: number;
  why: string;
}

export interface FocusPlan {
  today: { title: string; goal: string; minutes: number; why: string }[];
  later: string[];
}

const choiceZod = z.object({
  today: z
    .array(
      z.object({
        id: z.string(),
        goal: z.string(),
        minutes: z.number(),
        why: z.string(),
      }),
    )
    .max(8),
});

export const choiceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['today'],
  properties: {
    today: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'goal', 'minutes', 'why'],
        properties: {
          id: { type: 'string' },
          goal: { type: 'string' },
          minutes: { type: 'integer' },
          why: { type: 'string' },
        },
      },
    },
  },
};

export function applyChoice(candidates: Candidate[], chosen: Choice[]): FocusPlan {
  const byId = new Map(candidates.map((row) => [row.id, row]));
  const used = new Set<string>();
  const today: FocusPlan['today'] = [];
  for (const item of chosen) {
    if (today.length >= 3) break;
    const source = byId.get(item.id);
    if (!source || used.has(source.id)) continue;
    if (!item.goal.trim() || !item.why.trim() || !(item.minutes > 0)) continue;
    used.add(source.id);
    today.push({
      title: source.title,
      goal: item.goal.trim(),
      minutes: Math.round(item.minutes),
      why: item.why.trim(),
    });
  }
  return { today, later: candidates.filter((row) => !used.has(row.id)).map((row) => row.title) };
}

export function renderPlan(input: {
  plan: FocusPlan;
  yesterday: string[];
  todayMeetings: string[];
  matrix: string[];
  share: string;
}): string {
  const lines = ['Три дела на сегодня:'];
  if (input.plan.today.length === 0) lines.push('— модель не выбрала ни одного дела из кандидатов');
  input.plan.today.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title} — цель «${item.goal}», ${item.minutes} мин. ${item.why}`);
  });
  lines.push('', `Не сегодня: ${input.plan.later.join('; ') || 'нет'}.`);
  lines.push('', input.yesterday.length ? `Вчера: ${input.yesterday.join('; ')}.` : 'Вчера встреч в календаре не было.');
  lines.push(input.todayMeetings.length ? `Сегодня в календаре: ${input.todayMeetings.join('; ')}.` : 'Сегодня в календаре встреч нет.');
  lines.push('', 'Матрица отдела:', ...input.matrix);
  lines.push('', input.share);
  return lines.join('\n');
}

export async function chooseFocus(input: { purpose: string; profile: string; candidates: Candidate[] }): Promise<FocusPlan> {
  const result = await callJson<unknown>({
    purpose: input.purpose,
    system: [
      'Ты дирижёр фокуса руководителя.',
      'Из кандидатов выбери не больше трёх дел с наибольшим эффектом на час его времени.',
      'У каждого дела назови цель из профиля, оценку минут и почему эффект на час больше, чем у остальных.',
      'Бери только id из списка. Не выдумывай людей и дел.',
    ].join(' '),
    user: ['Профиль:', input.profile.trim(), '', 'Кандидаты:', JSON.stringify(input.candidates)].join('\n'),
    schemaName: 'focus_choice',
    schema: choiceSchema,
  });
  const parsed = choiceZod.safeParse(result.data);
  if (!parsed.success) throw new Error('Ответ модели не совпал со схемой трёх дел');
  return applyChoice(input.candidates, parsed.data.today);
}

const seriesZod = z.object({
  series: z.array(z.object({ title: z.string(), kind: z.enum(['решение', 'статус', 'один_на_один', 'внешняя']) })),
});

export const seriesSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['series'],
  properties: {
    series: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'kind'],
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['решение', 'статус', 'один_на_один', 'внешняя'] },
        },
      },
    },
  },
};

export async function classifySeries(input: {
  purpose: string;
  series: { title: string; attendees: string[] }[];
}): Promise<{ title: string; kind: string }[]> {
  if (input.series.length === 0) return [];
  const result = await callJson<unknown>({
    purpose: input.purpose,
    system: 'По названию и участникам определи вид встречи: решение, статус, один_на_один или внешняя. Не добавляй встречи, которых нет в списке.',
    user: JSON.stringify(input.series),
    schemaName: 'series_kind',
    schema: seriesSchema,
  });
  const parsed = seriesZod.safeParse(result.data);
  if (!parsed.success) throw new Error('Ответ модели не совпал со схемой вида встречи');
  const known = new Set(input.series.map((row) => row.title));
  return parsed.data.series.filter((row) => known.has(row.title));
}
